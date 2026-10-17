import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight, LoaderCircle } from "lucide-react";
import { api, isActiveStatus } from "../lib/api";
import type { RunStatus, Snapshot } from "../lib/types";
import { RunTranscript } from "./RunTranscript";
import "./execution.css";

export function HistoryProcess({
  runId,
  stepCount,
  hasReasoning = false,
  hasProcess = false,
  status,
  runError,
  hasArtifacts = false,
  snapshot,
  output,
  expanded,
  onExpandedChange,
  createdAt,
  updatedAt,
  renderBody,
}: {
  runId: string;
  stepCount: number;
  hasReasoning?: boolean;
  hasProcess?: boolean;
  status?: RunStatus;
  runError?: string;
  hasArtifacts?: boolean;
  snapshot?: Snapshot | null;
  output?: string;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  createdAt?: string;
  updatedAt?: string;
  renderBody: (text: string, id: string, streaming: boolean) => ReactNode;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = expanded ?? localOpen;
  const [loaded, setLoaded] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const owner = useRef(0);
  const cachedSnapshot = useRef<Snapshot | null>(null);
  const provided = snapshot?.run_id === runId ? snapshot : null;
  const remembered = provided ?? (cachedSnapshot.current?.run_id === runId ? cachedSnapshot.current : null);
  const saved = loaded?.run_id === runId && (!remembered || loaded.seq >= remembered.seq) ? loaded : remembered;
  const needsTerminal = Boolean(saved && isActiveStatus(saved.status) && status && !isActiveStatus(status));
  const current = saved && needsTerminal ? { ...saved, status: status!, output: status === "completed" ? output ?? saved.output : saved.output,
    created_at: createdAt ?? saved.created_at, updated_at: updatedAt ?? saved.updated_at,
    error: runError || saved.error, waiting_input: undefined } : saved;
  const recoveringPublic = needsTerminal && status !== "completed" && Boolean(output?.trim());
  // The terminal history projection can be ahead of a disconnected stream.
  // Keep all of it visible while the canonical process snapshot recovers.
  const visibleTimeline = recoveringPublic ? current!.timeline.filter((entry) => entry.kind !== "progress") : current?.timeline ?? [];
  const visibleOutput = recoveringPublic ? output! : current?.output ?? output ?? "";

  useEffect(() => {
    owner.current += 1;
    cachedSnapshot.current = null;
    setLoaded(null);
    setError("");
    setLoading(false);
    return () => { owner.current += 1; };
  }, [runId]);

  useEffect(() => {
    if (snapshot?.run_id !== runId) return;
    owner.current += 1;
    cachedSnapshot.current = snapshot;
    setLoading(false);
    setError("");
  }, [snapshot, runId]);

  useEffect(() => {
    if ((!open && !needsTerminal) || (current && !needsTerminal) || loading || error) return;
    const token = ++owner.current;
    setLoading(true);
    void api.run(runId).then((snapshot) => {
      if (owner.current !== token) return;
      if (snapshot.run_id !== runId || snapshot.seq < (saved?.seq ?? 0) || (needsTerminal && isActiveStatus(snapshot.status))) throw new Error("处理记录尚未同步");
      setLoaded(snapshot);
    }).catch(() => {
      if (owner.current === token) setError("暂时无法加载");
    }).finally(() => {
      if (owner.current === token) setLoading(false);
    });
  }, [open, runId, current, needsTerminal, saved?.seq, loading, error]);

  function change(next: boolean) {
    setLocalOpen(next);
    onExpandedChange?.(next);
    if (next && error) setError("");
  }

  return <>
    <RunTranscript timeline={visibleTimeline} output={visibleOutput}
      status={current?.status ?? status} waitingKind={current?.waiting_input?.kind} resource={current?.resource}
      error={runError || current?.error} hasArtifacts={hasArtifacts || Boolean(current?.artifacts?.length)}
      createdAt={current?.created_at ?? createdAt} updatedAt={current?.updated_at ?? updatedAt}
      expanded={expanded ?? localOpen} onExpandedChange={change} renderBody={renderBody} />
    {!current && (stepCount > 0 || hasReasoning || hasProcess) && <section className={`process history-process ${open ? "is-open" : ""}`}>
      <button className="process-toggle" onClick={() => change(!open)} aria-expanded={open}>
        <span className="process-title">处理过程</span>
        <span className="process-meta">{loading ? "加载中" : stepCount > 0 ? `${stepCount} 步` : hasReasoning ? "思考过程" : "处理过程"}</span>
        <ChevronRight size={16} className="process-chevron" />
      </button>
      {open && (loading ? <div className="history-loading"><LoaderCircle size={14} className="spin" /></div> : error ? <p className="form-error">{error}</p> : null)}
    </section>}
  </>;
}
