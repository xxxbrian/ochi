import { messagePresentation, projectRun } from "../../../shared/conversation/projection";
import { t, useI18n } from "../lib/i18n";
import { useState, type ReactNode } from "react";
import { ChevronRight, LoaderCircle } from "lucide-react";
import { useRunDetail } from "../hooks/useRunDetail";
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
      expanded={expanded ?? localOpen} onExpandedChange={change} renderBody={renderBody} />
    {!current && (stepCount > 0 || hasReasoning || hasProcess) && <section className={`process history-process ${open ? "is-open" : ""}`}>
      <button className="process-toggle" onClick={() => change(!open)} aria-expanded={open}>
        <span className="process-title">{t("process.title")}</span>
        <span className="process-meta">{loading ? t("status.loading") : stepCount > 0 ? t("process.steps", { count: stepCount }) : hasReasoning ? t("process.reasoning") : t("process.title")}</span>
        <ChevronRight size={16} className="process-chevron" />
      </button>
      {open && (loading ? <div className="history-loading"><LoaderCircle size={14} className="spin" /></div> : failed ? <p className="form-error">{t("error.loadTemporary")}</p> : null)}
    </section>}
  </>;
}
