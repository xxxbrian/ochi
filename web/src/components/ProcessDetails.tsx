import { t, useI18n } from "../lib/i18n";
import { Check, ChevronRight, CircleAlert, Square } from "lucide-react";
import { memo, useMemo, useState } from "react";
import type { ProcessEntry, RunStatus, WaitingInput } from "../lib/types";
import { lastMatching, orderedProcessEntries, processHasContent, toolInfo } from "../lib/processTimeline";
import { OchiActivityMark } from "./ThinkingDetails";
import { ProcessTimeline } from "./ProcessTimeline";
import { ProcessElapsed } from "./ProcessElapsed";
import "./execution.css";

export { StepList } from "./ProcessSteps";

type SummaryProps = {
  active: boolean;
  status?: RunStatus;
  waitingKind?: WaitingInput["kind"];
  resource?: string;
  timeline: ProcessEntry[];
  hasOutput?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  createdAt?: string;
  updatedAt?: string;
  compact?: boolean;
};

export const ProcessSummary = memo(function ProcessSummary({ active, status, waitingKind, resource, timeline, hasOutput = false, expanded, onExpandedChange, createdAt, updatedAt, compact = false }: SummaryProps) {
  useI18n();
  const entries = useMemo(() => orderedProcessEntries(timeline), [timeline]);
  const steps = entries.flatMap((entry) => entry.step ? [entry.step] : []);
  const completed = steps.filter((step) => step.status === "completed").length;
  const latest = lastMatching(entries, (entry) => Boolean(entry.step || entry.reasoning?.text.trim() || entry.text?.trim()));
  const tool = lastMatching(steps, (step) => step.status === "running");
  const working = active && status === "running";
  const failed = status === "failed" || status === "interrupted";
  const stopped = status === "cancelled";
  const thinking = working && latest?.kind === "reasoning" && !latest.reasoning?.done;
  const label = compact ? steps.length ? t("process.title") : entries.every((entry) => entry.reasoning?.kind === "summary") ? t("process.reasoningSummary") : t("process.reasoning")
    : failed ? t("status.failed") : stopped ? t("status.stopped") : status === "cancelling" ? t("status.stopping")
      : status === "queued" ? t("status.queued") : status === "waiting_resource" ? resource?.includes("desktop") || resource?.includes("computer") ? t("process.waitComputer") : t("process.waitProject")
        : status === "waiting_user" ? waitingKind === "computer_permission" ? t("status.awaitingPermission") : t("status.awaitingReply")
          : working && tool ? t("process.activeTool", { tool: toolInfo(tool.name).label }) : thinking ? t("process.thinking") : active ? hasOutput ? t("process.replying") : t("status.processing") : status === "completed" ? t("status.completed") : t("process.title");
  const contents = <>
    <span className="process-title">
      {!compact && (active ? <OchiActivityMark working={working} /> : failed ? <CircleAlert size={14} /> : stopped ? <Square size={13} /> : <Check size={14} />)}
      <span className={`ochi-status-label${working && !compact ? " is-working" : ""}`}>{label}</span>
    </span>
    {steps.length ? <span className="process-meta">{status === "completed" ? t("process.steps", { count: steps.length }) : `· ${t("process.completedSteps", { count: completed })}`}</span> : null}
    {!compact && <ProcessElapsed createdAt={createdAt} updatedAt={updatedAt} active={active} />}
    {onExpandedChange ? <ChevronRight size={16} className="process-chevron" /> : null}
  </>;
  return onExpandedChange
    ? <button className="process-toggle" onClick={() => onExpandedChange(!expanded)} aria-expanded={expanded}>{contents}</button>
    : <div className="process-toggle process-status" role={active ? "status" : undefined}>{contents}</div>;
});

export const ProcessDetails = memo(function ProcessDetails({
  active, beforeOutput = false, status, waitingKind, resource, error, timeline,
  hasOutput = false, expanded, onExpandedChange, createdAt, updatedAt,
  compact = false, bounded = true,
}: SummaryProps & { beforeOutput?: boolean; error?: string; bounded?: boolean }) {
  useI18n();
  const [localOpen, setLocalOpen] = useState(false);
  const open = expanded ?? localOpen;
  function toggle(next: boolean) {
    setLocalOpen(next);
    onExpandedChange?.(next);
  }
  if (!processHasContent(timeline) && !error && status === "running" && hasOutput) return null;
  const details = processHasContent(timeline) || Boolean(error);
  return <section className={`process ${beforeOutput ? "process-before-output" : ""} ${open ? "is-open" : ""}${compact ? " process-compact" : ""}`}>
    <ProcessSummary active={active} status={status} waitingKind={waitingKind} resource={resource} timeline={timeline} hasOutput={hasOutput}
      expanded={open} onExpandedChange={details ? toggle : undefined} createdAt={createdAt} updatedAt={updatedAt} compact={compact} />
    {open && details ? <ProcessTimeline timeline={timeline} active={active} error={error} bounded={bounded} /> : null}
  </section>;
});
