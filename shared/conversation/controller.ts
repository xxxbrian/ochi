import type { Artifact, Message, PendingRun, RunOptions, Session, SessionHead, SessionPatch, Snapshot } from "../contracts";
import { isActiveStatus } from "./events";
import { createRunStream, type RunTransport } from "./runStream";
import { canSupplementRun, createRunInstructionsStore, emptyInstructionState, type InstructionState } from "./instructions";

export type ConversationOwner = { origin: string; account: string; sessionId?: string; draftId?: string };
export function conversationKey(owner: ConversationOwner) {
  return JSON.stringify([owner.origin, owner.account, owner.sessionId ?? "", owner.sessionId ? "" : owner.draftId ?? "new"]);
}

export type ConversationTransport = RunTransport & {
  sessionHead(id: string, signal?: AbortSignal): Promise<SessionHead>;
  messages(id: string, before?: string, signal?: AbortSignal): Promise<Message[]>;
  queue(id: string, signal?: AbortSignal): Promise<PendingRun[]>;
  createSession(modelId?: string, effort?: string, projectId?: string, computerEnabled?: boolean): Promise<Session>;
  startRun(id: string, content: string, options?: RunOptions): Promise<Snapshot>;
  updateSession(id: string, patch: SessionPatch): Promise<Session>;
  cancelRun(id: string): Promise<Snapshot>;
  resumeRun(id: string, answer: string): Promise<Snapshot>;
  cancelQueuedRun(sessionId: string, runId: string): Promise<unknown>;
  updateQueuedRun(sessionId: string, runId: string, patch: { message: string }): Promise<unknown>;
  runInstructions: Parameters<typeof createRunInstructionsStore>[0]["runInstructions"];
  supplementRun: Parameters<typeof createRunInstructionsStore>[0]["supplementRun"];
};

export type ConversationState = {
  owner: ConversationOwner;
  ownerKey: string;
  adoptedFrom?: string;
  session: Session | null;
  messages: Message[];
  run: Snapshot | null;
  pending: PendingRun[];
  loading: boolean;
  posting: boolean;
  loadingOlder: boolean;
  hasOlder: boolean;
  error: unknown;
  reconnecting: boolean;
  instructions: InstructionState;
};
export type CreatedConversation = { session: Session; run?: Snapshot; error?: unknown };

export function emptyConversation(owner: ConversationOwner): ConversationState {
  return { owner, ownerKey: conversationKey(owner), session: null, messages: [], run: null, pending: [],
    loading: Boolean(owner.sessionId), posting: false, loadingOlder: false, hasOlder: false, error: null,
    reconnecting: false, instructions: emptyInstructionState };
}

function mergeHistory(current: Message[], recent: Message[], preserveOlder: boolean) {
  if (!preserveOlder || recent.length < 100) return recent;
  const ids = new Set(recent.map((message) => message.id));
  const first = recent[0]!;
  const boundary = current.findIndex((message) => message.id === first.id);
  const timeKey = (value: string) => value.replace(/(?:\.(\d+))?Z$/, (_match, fraction: string | undefined) => `.${(fraction ?? "").padEnd(9, "0")}Z`);
  const firstTime = timeKey(first.created_at);
  const older = boundary >= 0 ? current.slice(0, boundary) : current.filter((message) => {
    const time = timeKey(message.created_at);
    return time < firstTime || (time === firstTime && message.id < first.id);
  });
  return [...older.filter((message) => !ids.has(message.id) && !message.id.startsWith("pending-")), ...recent];
}

// There is one owner for command results, history and the live projection.
// Platform hooks supply lifecycle and transport; they never merge domain state.
export function createConversationController(transport: ConversationTransport, callbacks: {
  onSessionChanged?(session: Session): void;
  onExpired?(): void;
} = {}) {
  let state = emptyConversation({ origin: "", account: "" });
  let generation = 0, revision = 0;
  let enabled = false, preserveOlder = false;
  let writes = 0;
  let writeQueue: Promise<unknown> = Promise.resolve();
  let head: SessionHead | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let sync: { token: number; force: boolean; repeat: boolean; request: AbortController; promise: Promise<void> } | null = null;
  let older: AbortController | null = null;
  const listeners = new Set<() => void>();
  const receipts = createRunInstructionsStore(transport);
  const stream = createRunStream(transport, {
    onTerminal() { revision++; void refresh(true); },
    onExpired() { callbacks.onExpired?.(); },
  });
  let receiptSelection = "";
  const emit = (patch: Partial<ConversationState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const owns = (token: number) => token === generation;
  const syncReceipts = () => {
    const run = state.run;
    const next = JSON.stringify([state.ownerKey, state.owner.sessionId, run?.run_id, run?.status]);
    if (receiptSelection === next) return;
    receiptSelection = next;
    receipts.select(state.ownerKey, state.owner.sessionId, run?.run_id, run?.status);
  };
  stream.subscribe(() => {
    const value = stream.getSnapshot();
    if (value.snapshot && value.snapshot.session_id !== state.owner.sessionId) return;
    emit({ run: value.snapshot, reconnecting: value.reconnecting });
    syncReceipts();
  });
  receipts.subscribe(() => emit({ instructions: receipts.getSnapshot() }));
  function schedule() {
    clearTimeout(pollTimer);
    if (enabled && state.owner.sessionId) pollTimer = setTimeout(() => void refresh(), 4000);
  }
  function invalidateReads() {
    revision++;
    sync?.request.abort(); sync = null;
    older?.abort(); older = null;
    if (state.loadingOlder) emit({ loadingOlder: false });
  }
  function reset(owner: ConversationOwner) {
    generation++; revision++;
    clearTimeout(pollTimer);
    sync?.request.abort(); sync = null;
    older?.abort(); older = null;
    head = null; preserveOlder = false;
    writes = 0; writeQueue = Promise.resolve();
    state = emptyConversation(owner);
    stream.clear();
    receiptSelection = "";
    syncReceipts();
    emit({});
    if (enabled && owner.sessionId) void refresh(true);
  }
  async function refresh(force = false): Promise<void> {
    clearTimeout(pollTimer);
    const id = state.owner.sessionId;
    if (!id || state.posting || writes || (!enabled && !force)) { schedule(); return; }
    if (sync) {
      if (force) sync.repeat = true;
      return sync.promise;
    }
    const token = generation;
    const flight = { token, force, repeat: false, request: new AbortController(), promise: Promise.resolve() };
    sync = flight;
    flight.promise = (async () => {
      do {
        flight.force ||= flight.repeat;
        flight.repeat = false;
        const version = revision;
        const valid = () => owns(token) && revision === version && sync === flight;
        try {
          const incoming = await transport.sessionHead(id, flight.request.signal);
          if (!valid()) continue;
          if (incoming.session.id !== id) throw new Error("Conversation identity changed");
          const current = stream.getCurrent();
          const latest = incoming.latest_run;
          const historyChanged = flight.force || !head || head.history_revision !== incoming.history_revision ||
            head.latest_run?.run_id !== latest?.run_id;
          const queueChanged = flight.force || !head || head.queue_revision !== incoming.queue_revision;
          const runChanged = Boolean(latest && (!current || latest.run_id !== current.run_id ||
            (!isActiveStatus(latest.status) && (latest.seq > current.seq || latest.status !== current.status))));
          const [messages, pending, snapshot] = await Promise.all([
            historyChanged ? transport.messages(id, undefined, flight.request.signal) : null,
            queueChanged ? transport.queue(id, flight.request.signal) : null,
            runChanged ? transport.run(latest!.run_id, flight.request.signal) : null,
          ]);
          if (!valid()) continue;
          const sessionChanged = !head || JSON.stringify(head.session) !== JSON.stringify(incoming.session);
          const patch: Partial<ConversationState> = { session: incoming.session, loading: false, error: null };
          if (messages) {
            older?.abort(); older = null;
            patch.loadingOlder = false;
            patch.messages = mergeHistory(state.messages, messages, preserveOlder);
            if (messages.length < 100) { preserveOlder = false; patch.hasOlder = false; }
            else if (!preserveOlder) patch.hasOlder = true;
          }
          if (pending) patch.pending = pending;
          head = incoming;
          emit(patch);
          if (snapshot) stream.follow(snapshot);
          else if (!latest && current) stream.clear();
          if (sessionChanged) callbacks.onSessionChanged?.(incoming.session);
        } catch (error) {
          if (valid()) {
            emit({ loading: false, error });
            if (error && typeof error === "object" && "status" in error && error.status === 401) callbacks.onExpired?.();
          }
        }
      } while (flight.repeat && owns(token) && !state.posting);
    })().finally(() => {
      if (sync === flight) { sync = null; schedule(); }
    });
    return flight.promise;
  }
  function command<T>(call: (sessionId: string) => Promise<T>, accept: (value: T) => void | Promise<void>) {
    const id = state.owner.sessionId, token = generation;
    if (!id) return Promise.resolve(undefined);
    writes++;
    invalidateReads();
    const operation = writeQueue.catch(() => undefined).then(async () => {
      if (!owns(token)) return;
      try {
        const result = await call(id);
        if (!owns(token)) return;
        revision++;
        await accept(result);
        return result;
      } catch (error) {
        if (owns(token)) throw error;
      } finally {
        if (owns(token)) {
          writes--;
          if (!writes) await refresh(true);
        }
      }
    });
    writeQueue = operation;
    return operation;
  }
  const controller = {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => state,
    select(owner: ConversationOwner) {
      if (conversationKey(owner) === state.ownerKey) {
        if (state.adoptedFrom) emit({ adoptedFrom: undefined });
        return;
      }
      reset(owner);
    },
    setEnabled(value: boolean) {
      if (enabled === value) return;
      enabled = value;
      stream.setEnabled(value); receipts.setEnabled(value);
      if (value) void refresh(); else {
        clearTimeout(pollTimer);
        sync?.request.abort(); sync = null;
      }
    },
    refresh,
    refreshAll: () => refresh(true),
    async createAndSend(content: string, options: RunOptions & { attachments?: Artifact[]; project_id?: string; computer_enabled?: boolean } = {}): Promise<CreatedConversation | undefined> {
      const token = generation;
      if (state.owner.sessionId || state.posting) return;
      emit({ posting: true, error: null });
      let created: Session | undefined;
      try {
        created = await transport.createSession(options.model_id, options.effort, options.project_id, options.computer_enabled);
        if (!owns(token)) return;
        const previous = state.ownerKey;
        const owner = { ...state.owner, sessionId: created.id };
        emit({ owner, ownerKey: conversationKey(owner), adoptedFrom: previous, session: created, loading: false, posting: false });
        syncReceipts();
        callbacks.onSessionChanged?.(created);
        const { project_id: _project, computer_enabled: _computer, ...runOptions } = options;
        const run = await controller.send(content, runOptions);
        return owns(token) ? { session: created, run } : undefined;
      } catch (error) {
        if (!owns(token)) return;
        emit({ error });
        if (created) return { session: created, error };
        throw error;
      } finally {
        if (owns(token)) { emit({ posting: false }); schedule(); }
      }
    },
    async loadOlder() {
      const id = state.owner.sessionId, first = state.messages[0], token = generation, version = revision;
      if (!id || !first || !state.hasOlder || older) return;
      const request = new AbortController(); older = request;
      emit({ loadingOlder: true });
      try {
        const messages = await transport.messages(id, first.id, request.signal);
        if (!owns(token) || revision !== version || older !== request) return;
        const ids = new Set(state.messages.map((message) => message.id));
        preserveOlder = true;
        emit({ messages: [...messages.filter((message) => !ids.has(message.id)), ...state.messages], hasOlder: messages.length >= 100 });
      } finally {
        if (older === request) { older = null; if (owns(token)) emit({ loadingOlder: false }); }
      }
    },
    async send(content: string, options: RunOptions & { attachments?: Artifact[] } = {}) {
      const id = state.owner.sessionId, token = generation;
      if (!id || state.posting) return;
      const revised = options.retry_run_id ?? state.messages.find((message) => message.id === options.edit_message_id)?.run_id;
      const optimistic: Message = { id: `pending-${Date.now()}`, role: "user", content,
        attachments: options.attachments, created_at: new Date().toISOString() };
      emit({ posting: true, error: null, messages: [...state.messages, optimistic] });
      try {
        const { attachments: _attachments, ...request } = options;
        return await command((sessionId) => transport.startRun(sessionId, content, request), (result) => {
          emit({ posting: false, messages: result.status === "queued"
            ? state.messages.filter((message) => message.id !== optimistic.id)
            : state.messages.filter((message) => !(revised && message.run_id === revised) && message.id !== options.edit_message_id) });
          if (result.status !== "queued") stream.follow(result);
        });
      } catch (error) {
        if (!owns(token)) return;
        emit({ error, messages: state.messages.filter((message) => message.id !== optimistic.id) });
        throw error;
      } finally {
        if (owns(token)) { emit({ posting: false }); schedule(); }
      }
    },
    stop() {
      const run = state.run;
      return !run ? Promise.resolve(undefined) : command(() => transport.cancelRun(run.run_id), async (value) => {
        if (stream.getCurrent()?.run_id === run.run_id) stream.follow(value);
      });
    },
    resume(answer: string) {
      const run = state.run;
      return !run ? Promise.resolve(undefined) : command(() => transport.resumeRun(run.run_id, answer), async (value) => {
        if (stream.getCurrent()?.run_id === run.run_id) stream.follow(value);
      });
    },
    updateSession(patch: SessionPatch) {
      return command((id) => transport.updateSession(id, patch), (value) => {
        emit({ session: value });
        callbacks.onSessionChanged?.(value);
      });
    },
    cancelQueued(runId: string) {
      return command((id) => transport.cancelQueuedRun(id, runId), () => {});
    },
    updateQueued(runId: string, message: string) {
      return command((id) => transport.updateQueuedRun(id, runId, { message }), () => {});
    },
    supplement(content: string) { return receipts.send(state.ownerKey, content); },
    retrySupplement: () => receipts.retry(),
    refreshInstructions: () => receipts.refresh(),
    canSupplement: () => enabled && canSupplementRun(state.run?.status) && !state.instructions.retry,
    dispose() {
      enabled = false; generation++; clearTimeout(pollTimer);
      sync?.request.abort(); older?.abort();
      stream.dispose(); receipts.dispose(); listeners.clear();
    },
  };
  return controller;
}
