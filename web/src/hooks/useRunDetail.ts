import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { createRunDetail } from "../../../shared/conversation/runDetail";
import { api } from "../lib/api";
import type { RunStatus, Snapshot } from "../lib/types";

export function useRunDetail(runId: string, supplied: Snapshot | null, status: RunStatus | undefined, open: boolean) {
  const resource = useMemo(() => createRunDetail(api), []);
  const state = useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getSnapshot);
  useLayoutEffect(() => { resource.select(runId, supplied, status, open); }, [resource, runId, supplied, status, open]);
  useEffect(() => { resource.setEnabled(true); return () => resource.setEnabled(false); }, [resource]);
  const snapshot = supplied?.run_id === runId && (!state.snapshot || supplied.seq >= state.snapshot.seq)
    ? supplied : state.snapshot?.run_id === runId ? state.snapshot : null;
  return { ...state, snapshot, retry: resource.retry };
}
