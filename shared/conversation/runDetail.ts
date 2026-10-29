import type { RunStatus, Snapshot } from "../contracts";
import { isActiveStatus } from "./events";
import type { RunTransport } from "./runStream";

export function createRunDetail(transport: Pick<RunTransport, "run">) {
  let runId = "", generation = 0, enabled = false, open = false;
  let requiredStatus: RunStatus | undefined;
  let state: { snapshot: Snapshot | null; loading: boolean; failed: boolean } = { snapshot: null, loading: false, failed: false };
  let request: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const emit = (patch: Partial<typeof state>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const needsTerminal = () => Boolean(state.snapshot && isActiveStatus(state.snapshot.status) && requiredStatus && !isActiveStatus(requiredStatus));
  const needed = () => enabled && runId && (needsTerminal() || (open && !state.snapshot));
  function cancel() {
    generation++;
    request?.abort(); request = null;
    clearTimeout(retryTimer); clearTimeout(timeout);
    retryTimer = undefined; timeout = undefined;
  }
  async function load(attempt = 0) {
    if (!needed() || request || retryTimer || state.failed) return;
    const token = generation, id = runId, controller = new AbortController();
    request = controller;
    emit({ loading: true, failed: false });
    try {
      const snapshot = await Promise.race([
        transport.run(id, controller.signal),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => { controller.abort(); reject(new Error("Run detail request timed out")); }, 10_000);
        }),
      ]);
      if (token !== generation) return;
      if (snapshot.run_id !== id || snapshot.seq < (state.snapshot?.seq ?? 0) ||
        (requiredStatus && !isActiveStatus(requiredStatus) && isActiveStatus(snapshot.status)))
        throw new Error("Run detail is behind its history revision");
      emit({ snapshot, loading: false, failed: false });
    } catch {
      if (token !== generation) return;
      if (attempt < 2 && needed()) retryTimer = setTimeout(() => {
        retryTimer = undefined; void load(attempt + 1);
      }, attempt === 0 ? 500 : 1500);
      else emit({ loading: false, failed: true });
    } finally {
      if (token === generation) { request = null; clearTimeout(timeout); timeout = undefined; }
    }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    select(id: string, snapshot: Snapshot | null, status: RunStatus | undefined, expanded: boolean) {
      if (id !== runId) {
        cancel(); runId = id; emit({ snapshot: null, loading: false, failed: false });
      }
      requiredStatus = status; open = expanded;
      if (snapshot?.run_id === id && (!state.snapshot || snapshot.seq >= state.snapshot.seq) && snapshot !== state.snapshot) {
        cancel();
        emit({ snapshot, loading: false, failed: false });
      }
      if (!needed() && (request || retryTimer)) { cancel(); emit({ loading: false }); }
      void load();
    },
    setEnabled(value: boolean) {
      if (enabled === value) return;
      enabled = value;
      if (!enabled) { cancel(); if (state.loading) emit({ loading: false }); }
      else void load();
    },
    retry() { if (state.failed) emit({ failed: false }); void load(); },
  };
}
