import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { api } from "../lib/api";
import { canSupplementRun, createRunInstructionsStore, emptyInstructionState } from "../lib/runInstructions";
import type { Snapshot } from "../lib/types";

export function useRunInstructions(owner: string, sessionId: string | undefined, snapshot: Snapshot | null, enabled = true) {
  const ref = useRef<ReturnType<typeof createRunInstructionsStore> | null>(null);
  if (!ref.current) ref.current = createRunInstructionsStore(api);
  const store = ref.current;
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const run = snapshot?.session_id === sessionId ? snapshot : null;
  useLayoutEffect(() => { store.select(owner, sessionId, run?.run_id, run?.status); }, [store, owner, sessionId, run?.run_id, run?.status]);
  useEffect(() => {
    const update = () => store.setEnabled(enabled && document.visibilityState !== "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    return () => { document.removeEventListener("visibilitychange", update); store.setEnabled(false); };
  }, [store, enabled]);
  useEffect(() => () => store.dispose(), [store]);
  const send = useCallback((content: string) => store.send(owner, content), [store, owner]);
  const retry = useCallback(() => store.retry(), [store]);
  const refresh = useCallback(() => store.refresh(), [store]);
  const visible = state.owner === owner ? state : emptyInstructionState;
  return { ...visible, retryPending: visible.retry, canSend: Boolean(enabled && run && canSupplementRun(run.status) && !visible.retry), send, retry, refresh };
}
