import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { api } from '../lib/api';
import { canSupplementRun, createRunInstructionsStore, emptyInstructionState } from '../../../web/src/lib/runInstructions';
import type { Snapshot } from '../lib/types';

export function useRunInstructions(owner: string, sessionId: string | undefined, snapshot: Snapshot | null, focused = true) {
  const ref = useRef<ReturnType<typeof createRunInstructionsStore> | null>(null);
  if (!ref.current) ref.current = createRunInstructionsStore(api);
  const store = ref.current;
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const run = snapshot?.session_id === sessionId ? snapshot : null;
  useLayoutEffect(() => { store.select(owner, sessionId, run?.run_id, run?.status); }, [store, owner, sessionId, run?.run_id, run?.status]);
  useEffect(() => {
    const update = () => store.setEnabled(focused && AppState.currentState === 'active');
    update();
    const subscription = AppState.addEventListener('change', update);
    return () => { subscription.remove(); store.setEnabled(false); };
  }, [store, focused]);
  useEffect(() => () => store.dispose(), [store]);
  const send = useCallback((content: string) => store.send(owner, content), [store, owner]);
  const retry = useCallback(() => store.retry(), [store]);
  const refresh = useCallback(() => store.refresh(), [store]);
  const visible = state.owner === owner ? state : emptyInstructionState;
  return { ...visible, retryPending: visible.retry, canSend: Boolean(focused && run && canSupplementRun(run.status) && !visible.retry), send, retry, refresh };
}
