import type { Snapshot } from "../contracts";
import { isActiveStatus, reduceRunDelta, type RunEvent } from "./events";

export type StreamHandlers = {
  onOpen(): void;
  onEvent(event: RunEvent): void;
  onClose(error?: Error & { status?: number }): void;
};
export type RunTransport = {
  run(id: string, signal?: AbortSignal): Promise<Snapshot>;
  connect(id: string, handlers: StreamHandlers): () => void;
};

export function createRunStream(transport: RunTransport, callbacks: {
  onTerminal?(snapshot: Snapshot): void;
  onExpired?(): void;
} = {}) {
  let state: { snapshot: Snapshot | null; reconnecting: boolean } = { snapshot: null, reconnecting: false };
  let live: Snapshot | null = null;
  let enabled = false;
  let close: (() => void) | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let failures = 0;
  let resync: AbortController | null = null;
  const listeners = new Set<() => void>();
  const publish = (reconnecting = state.reconnecting) => {
    clearTimeout(flushTimer); flushTimer = undefined;
    if (live === state.snapshot && reconnecting === state.reconnecting) return;
    state = { snapshot: live, reconnecting };
    for (const listener of listeners) listener();
  };
  const disconnect = () => {
    generation++;
    close?.(); close = null;
    resync?.abort(); resync = null;
    clearTimeout(retryTimer); retryTimer = undefined;
    clearTimeout(flushTimer); flushTimer = undefined;
  };
  const finish = () => {
    const snapshot = live;
    disconnect(); publish(false);
    if (snapshot) callbacks.onTerminal?.(snapshot);
  };
  const expire = () => {
    disconnect(); live = null; publish(false); callbacks.onExpired?.();
  };
  const retry = () => {
    if (!enabled || !live || retryTimer) return;
    publish(true);
    retryTimer = setTimeout(() => { retryTimer = undefined; void recover(); }, Math.min(500 * 2 ** failures++, 5000));
  };
  async function recover() {
    if (!enabled || !live || resync) return;
    close?.(); close = null;
    const token = ++generation;
    const id = live.run_id;
    const controller = new AbortController();
    resync = controller;
    publish(true);
    try {
      const snapshot = await transport.run(id, controller.signal);
      if (token !== generation || !enabled) return;
      if (snapshot.run_id !== id || snapshot.session_id !== live?.session_id) throw new Error("Run identity changed");
      if (snapshot.seq >= live.seq) live = snapshot;
      resync = null;
      publish(false);
      if (!isActiveStatus(snapshot.status)) finish();
      else connect();
    } catch (error) {
      if (token !== generation || !enabled) return;
      resync = null;
      if (error && typeof error === "object" && "status" in error && error.status === 401) expire();
      else retry();
    }
  }
  function connect() {
    if (!enabled || !live || !isActiveStatus(live.status) || close || resync) return;
    const token = generation, id = live.run_id, sessionId = live.session_id;
    const current = () => enabled && token === generation && live?.run_id === id && live.session_id === sessionId;
    close = transport.connect(id, {
      onOpen() { if (current()) { failures = 0; publish(false); } },
      onEvent(event) {
        if (!current() || event.value.run_id !== id || !live) return;
        if (event.kind === "snapshot") {
          if (event.value.session_id !== sessionId || event.value.seq < live.seq) return;
          live = event.value; publish(false);
        } else {
          if (event.value.seq <= live.seq) return;
          if (event.value.seq !== live.seq + 1) { void recover(); return; }
          live = reduceRunDelta(live, event);
          if (!flushTimer) flushTimer = setTimeout(() => publish(), 50);
        }
        if (!isActiveStatus(live.status)) finish();
      },
      onClose(error) {
        if (!current()) return;
        close = null;
        if (error?.status === 401) expire(); else retry();
      },
    });
  }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => state,
    getCurrent: () => live,
    follow(snapshot: Snapshot) {
      const same = snapshot.run_id === live?.run_id && snapshot.session_id === live?.session_id;
      if (same && snapshot.seq < live!.seq) return;
      if (!same) { disconnect(); failures = 0; }
      if (!same || snapshot.seq !== live!.seq || snapshot.status !== live!.status) live = snapshot;
      publish(false);
      if (isActiveStatus(snapshot.status)) connect();
      else { disconnect(); publish(false); }
    },
    clear() { disconnect(); live = null; failures = 0; publish(false); },
    setEnabled(value: boolean) {
      if (enabled === value) return;
      enabled = value;
      if (!value) { disconnect(); publish(false); }
      else connect();
    },
    refresh: recover,
    dispose() { enabled = false; disconnect(); listeners.clear(); },
  };
}
