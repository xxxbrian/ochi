import { messagePresentation, projectRun } from "../../../shared/conversation/projection";
import { t, useI18n } from "../lib/i18n";
import { useState, type ReactNode } from "react";
import { Check, ChevronRight } from "lucide-react";
import { useRunDetail } from "../hooks/useRunDetail";
import type { RunStatus, Snapshot } from "../lib/types";
import { RunTranscript } from "./RunTranscript";
import "./process.css";

export function HistoryProcess({
  runId,
  stepCount,
  hasReasoning = false,
  hasProcess = false,
  status,
  runError,
  runErrorCode,
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
  runErrorCode?: string;
  hasArtifacts?: boolean;
  snapshot?: Snapshot | null;
  output?: string;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  createdAt?: string;
  updatedAt?: string;
  renderBody: (text: string, id: string, streaming: boolean) => ReactNode;
}) {
  useI18n();
  const [localOpen, setLocalOpen] = useState(false);
  const open = expanded ?? localOpen;
  const detail = useRunDetail(runId, snapshot ?? null, status, open);
  const { snapshot: saved, loading, failed } = detail;
  const presentation = messagePresentation({ id: runId, run_id: runId, role: 'assistant', content: output ?? '',
    created_at: createdAt ?? '', run_status: status, run_error: runError, run_error_code: runErrorCode,
    run_created_at: createdAt, run_updated_at: updatedAt }, saved);
  const { snapshot: current } = presentation;
  const visibleTimeline = current ? projectRun(current).entries : [];
  const visibleOutput = presentation.fallback;

  function change(next: boolean) {
    setLocalOpen(next);
    onExpandedChange?.(next);
    if (next && failed) detail.retry();
  }

  return <>
    <RunTranscript timeline={visibleTimeline} output={visibleOutput}
      status={current?.status ?? status} waitingKind={current?.waiting_input?.kind} resource={current?.resource}
      error={runError || current?.error} errorCode={runErrorCode || current?.error_code} hasArtifacts={hasArtifacts || Boolean(current?.artifacts?.length)}
      createdAt={current?.created_at ?? createdAt} updatedAt={current?.updated_at ?? updatedAt}
      expanded={expanded} onExpandedChange={change} renderBody={renderBody} />
    {!current && (stepCount > 0 || hasReasoning || hasProcess) && <div className="proc" data-state="done" data-open={open}>
      <button className="proc-head" onClick={() => change(!open)} aria-expanded={open}>
        <span className="ind ind-done"><Check className="ic" /></span>
        <span className="proc-label"><span className="roll">
          <span className="lbl-main">{loading ? t("status.loading") : t("process.title")}</span>
          {!loading ? <span className="lbl-sub">{stepCount > 0 ? t("process.steps", { count: stepCount }) : hasReasoning ? t("process.reasoning") : ""}</span> : null}
        </span></span>
        <ChevronRight className="chev ic" aria-hidden="true" />
      </button>
      {open && (loading ? <div className="history-skel" aria-hidden="true">{[58, 74, 46].map((width) => <div key={width}><i className="skel circle" /><i className="skel line" style={{ width: `${width}%` }} /></div>)}</div> : failed ? <p className="form-error">{t("error.loadTemporary")}</p> : null)}
    </div>}
  </>;
}
