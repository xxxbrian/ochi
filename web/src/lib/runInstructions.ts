import type { ApiError, RunInstruction, RunStatus } from "./types";

export type InstructionReceipt = RunInstruction & { run_id: string };
export type InstructionAcceptance = { id: string; content: string };
export type InstructionState = {
  owner: string;
  items: InstructionReceipt[];
  submitting: boolean;
  error: string;
  syncError: string;
  retry: boolean;
  accepted?: InstructionAcceptance;
};
type Transport = {
  runInstructions: (runId: string, signal: AbortSignal) => Promise<RunInstruction[]>;
  supplementRun: (runId: string, content: string, clientKey: string, signal: AbortSignal) => Promise<RunInstruction>;
};
type Attempt = { owner: string; runId: string; content: string; clientKey: string };
type TrackedRun = { id: string; status?: RunStatus; terminalReads: number };

export function canSupplementRun(status?: RunStatus) {
  return status === "running" || status === "waiting_user" || status === "waiting_resource";
}

export function instructionStatusLabel(status: RunInstruction["status"]) {
  return { pending: "已接收", applied: "已应用", queued: "已排队", not_applied: "未应用" }[status];
}

export const emptyInstructionState: InstructionState = {
  owner: "", items: [], submitting: false, error: "", syncError: "", retry: false,
};

// This store has no React/platform dependencies. Only real receipts enter its list.
export function createRunInstructionsStore(transport: Transport) {
  let state = emptyInstructionState;
  let sessionId: string | undefined;
  let currentRun: TrackedRun | undefined;
  let runs: TrackedRun[] = [];
  let enabled = false;
  let failedReads = 0;
  let refreshAgain = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let loading: object | undefined;
  let sending: Attempt | undefined;
  let uncertain: Attempt | undefined;
  let keySequence = 0;
  let receiptRevision = 0;
  const receiptVersions = new Map<string, number>();
  const requests = new Set<AbortController>();
  const listeners = new Set<() => void>();

  function commit(patch: Partial<InstructionState>) {
    const next = { ...state, ...patch };
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    state = next;
    const retained = new Set(state.items.map((item) => item.id));
    for (const id of receiptVersions.keys()) if (!retained.has(id)) receiptVersions.delete(id);
    listeners.forEach((listener) => listener());
  }
  function clearTimer() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }
  function owns(attempt: Attempt) { return state.owner === attempt.owner && Boolean(sessionId); }
  function receipt(attempt: Attempt) {
    return state.items.find((item) => item.run_id === attempt.runId && item.client_key === attempt.clientKey);
  }
  function accepted(attempt: Attempt, value: RunInstruction) {
    if (!owns(attempt)) return;
    if (uncertain === attempt) uncertain = undefined;
    const item = { ...value, run_id: attempt.runId };
    receiptVersions.set(value.id, ++receiptRevision);
    commit({
      items: [...state.items.filter((prior) => prior.id !== value.id), item].slice(-64),
      accepted: { id: value.id, content: attempt.content }, retry: Boolean(uncertain), error: "",
    });
  }
  async function bounded<T>(call: (signal: AbortSignal) => Promise<T>) {
    const controller = new AbortController();
    requests.add(controller);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        call(controller.signal),
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new Error("暂时无法确认"));
          controller.signal.addEventListener("abort", onAbort, { once: true });
          timeout = setTimeout(() => controller.abort(), 8000);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (onAbort) controller.signal.removeEventListener("abort", onAbort);
      requests.delete(controller);
    }
  }
  function wantsRefresh() {
    return runs.some((run) => canSupplementRun(run.status) || run.status === "cancelling" ||
      (state.items.some((item) => item.run_id === run.id && item.status === "pending") && run.terminalReads < 3));
  }
  function schedule() {
    clearTimer();
    if (enabled && sessionId && wantsRefresh())
      timer = setTimeout(() => void refresh(), Math.min(30000, 2000 * 2 ** Math.min(failedReads, 4)));
  }
  async function refresh(): Promise<void> {
    clearTimer();
    if (!enabled || !sessionId || !runs.length) return;
    if (loading) { refreshAgain = true; return; }
    const flight = {}, owner = state.owner, selectedRuns = [...runs], revision = receiptRevision;
    loading = flight;
    try {
      const results = await Promise.all(selectedRuns.map(async (run): Promise<{
        run: TrackedRun; items: RunInstruction[] | null; error?: unknown;
      }> => {
        try { return { run, items: await bounded((signal) => transport.runInstructions(run.id, signal)) }; }
        catch (error) { return { run, items: null, error }; }
      }));
      if (state.owner !== owner || !enabled || loading !== flight) return;
      const ids = new Set(results.filter((result) => result.items !== null).map((result) => result.run.id));
      const incoming = results.flatMap(({ run, items }) => (items ?? []).map((item) => ({ ...item, run_id: run.id })));
      // A GET started before an acknowledgement must not regress that receipt,
      // even if its stale response already contains the same ID as pending.
      const newerIds = new Set(state.items.filter((item) => (receiptVersions.get(item.id) ?? 0) > revision).map((item) => item.id));
      const items = [...state.items.filter((item) => !ids.has(item.run_id) ||
        newerIds.has(item.id)), ...incoming.filter((item) => !newerIds.has(item.id))].slice(-64);
      for (const result of results) {
        // An older GET cannot revive a run after the stream already observed terminal state.
        if (result.items?.[0]?.run_status && (canSupplementRun(result.run.status) || result.run.status === "cancelling"))
          result.run.status = result.items[0].run_status;
        if (!canSupplementRun(result.run.status) && result.run.status !== "cancelling") result.run.terminalReads += 1;
        const status = (result.error as ApiError)?.status;
        if (result.run !== currentRun && (status === 403 || status === 404)) runs = runs.filter((run) => run !== result.run);
      }
      const failed = results.some((result) => result.items === null);
      failedReads = failed ? failedReads + 1 : 0;
      const unresolved = selectedRuns.some((run) => !canSupplementRun(run.status) && run.status !== "cancelling" &&
        run.terminalReads >= 3 && items.some((item) => item.run_id === run.id && item.status === "pending"));
      commit({ items, syncError: unresolved || (failed && items.length > 0) ? "补充状态暂时无法同步" : "" });
      if (uncertain) { const found = receipt(uncertain); if (found) accepted(uncertain, found); }
    } catch {
      if (state.owner !== owner || !enabled || loading !== flight) return;
      failedReads += 1;
      for (const run of selectedRuns) if (!canSupplementRun(run.status) && run.status !== "cancelling") run.terminalReads += 1;
      if (state.items.length) commit({ syncError: "补充状态暂时无法同步" });
    } finally {
      if (loading === flight) {
        loading = undefined;
        if (refreshAgain) { refreshAgain = false; void refresh(); }
        else schedule();
      }
    }
  }
  async function post(attempt: Attempt): Promise<boolean> {
    if (!owns(attempt) || sending) return false;
    sending = attempt;
    commit({ submitting: true, error: "" });
    try {
      // Replaying this POST is safe only because both attempts use the exact key/body.
      for (let index = 0; index < 2; index += 1) {
        try {
          const value = await bounded((signal) => transport.supplementRun(attempt.runId, attempt.content, attempt.clientKey, signal));
          if (!owns(attempt)) return false;
          accepted(attempt, value);
          void refresh();
          return true;
        } catch (reason) {
          if (!owns(attempt)) return false;
          const found = receipt(attempt);
          if (found) { accepted(attempt, found); return true; }
          const status = (reason as ApiError)?.status;
          if (status && status < 500 && status !== 429) {
            uncertain = undefined;
            commit({ retry: false, error: status === 409 ? "任务已结束或补充未被接收" : reason instanceof Error ? reason.message : "补充未发送" });
            return false;
          }
          if (index === 1) {
            uncertain = attempt;
            commit({ retry: true, error: "补充要求暂时无法确认" });
            return false;
          }
        }
      }
      return false;
    } finally {
      if (sending === attempt) {
        sending = undefined;
        if (owns(attempt)) commit({ submitting: false });
      }
    }
  }
  function select(owner: string, id?: string, runId?: string, status?: RunStatus) {
    if (state.owner !== owner) {
      clearTimer();
      requests.forEach((request) => request.abort());
      requests.clear();
      loading = undefined; sending = undefined; uncertain = undefined;
      runs = []; currentRun = undefined; failedReads = 0; refreshAgain = false;
      receiptVersions.clear(); receiptRevision = 0;
      sessionId = id;
      state = { ...emptyInstructionState, owner };
      listeners.forEach((listener) => listener());
    }
    if (!id || !runId) return;
    let run = runs.find((item) => item.id === runId);
    if (!run) {
      if (currentRun && canSupplementRun(currentRun.status)) {
        currentRun.status = undefined;
        currentRun.terminalReads = 0;
      }
      run = { id: runId, status, terminalReads: 0 };
      // Retain a previous pending receipt until its terminal disposition is read.
      runs = [...runs.filter((prior) => prior.id === uncertain?.runId || prior.id === sending?.runId ||
        state.items.some((item) => item.run_id === prior.id && item.status === "pending")).slice(-2), run];
    } else if (status !== run.status) {
      run.status = status;
      run.terminalReads = 0;
    }
    currentRun = run;
    void refresh();
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    select,
    setEnabled(value: boolean) {
      enabled = value;
      if (value) void refresh();
      else { clearTimer(); }
    },
    refresh,
    async send(owner: string, content: string) {
      if (owner !== state.owner || !enabled || !currentRun || !canSupplementRun(currentRun.status) || uncertain || !content.trim()) return false;
      if (new TextEncoder().encode(content).length > 32000) { commit({ error: "补充要求太长" }); return false; }
      const clientKey = `ochi-${Date.now().toString(36)}-${(++keySequence).toString(36)}-${Math.random().toString(36).slice(2)}`;
      return post({ owner, runId: currentRun.id, content, clientKey });
    },
    retry() { return uncertain ? post(uncertain) : Promise.resolve(false); },
    dispose() {
      enabled = false; clearTimer(); state = emptyInstructionState;
      requests.forEach((request) => request.abort()); requests.clear();
      loading = undefined; sending = undefined; listeners.clear();
    },
  };
}
