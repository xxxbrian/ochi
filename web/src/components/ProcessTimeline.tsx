import { t, useI18n } from "../lib/i18n";
import { Check, ChevronRight, CircleAlert, Hourglass, Square } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ProcessEntry, RunStatus, WaitingInput } from "../lib/types";
import { groupProcessEntries, stepFamilies, type ToolFamily } from "../lib/processTimeline";
import { describeHeader, type HeaderState } from "../lib/processHeader";
import { formatProcessElapsed, processElapsedMilliseconds } from "../lib/processTiming";
import { useEntryClock, type EntryClock } from "../lib/entryClock";
import { ComputerQueueDetails } from "./ComputerQueueDetails";
import { Collapse, hueStyle, ProgressRow, RunningBars, ThinkingRow, ToolGroup, ToolRow, toolIcon } from "./ProcessSteps";
import "./process.css";

// Previous labels roll out upward while the new one rolls in, so a state change reads as motion, not a flash.
function RollingLabel({ id, shimmer, children }: { id: string; shimmer: boolean; children: ReactNode }) {
  const last = useRef<{ id: string; node: ReactNode }>({ id, node: children });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [leaving, setLeaving] = useState<{ id: string; node: ReactNode } | null>(null);
  const [rolled, setRolled] = useState(false);
  useLayoutEffect(() => {
    if (last.current.id === id) return;
    setLeaving(last.current);
    setRolled(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setLeaving(null), 400);
  }, [id]);
  useLayoutEffect(() => { last.current = { id, node: children }; });
  useLayoutEffect(() => () => clearTimeout(timer.current), []);
  return (
    <span className="proc-label">
      {leaving ? <span className="roll roll-out" key={`out:${leaving.id}`} aria-hidden="true">{leaving.node}</span> : null}
      <span className={`roll${rolled ? " roll-in" : ""}${shimmer ? " shimmer" : ""}`} key={id}>{children}</span>
    </span>
  );
}

function Indicator({ state }: { state: HeaderState }) {
  if (state === "done") return <span className="ind ind-done"><Check className="ic" /></span>;
  if (state === "failed") return <span className="ind ind-bad"><CircleAlert className="ic" /></span>;
  if (state === "stopped") return <span className="ind ind-stop"><Square className="ic" /></span>;
  if (state === "waiting") return <span className="ind ind-wait"><Hourglass className="ic" /></span>;
  return <span className="ind"><RunningBars count={4} /></span>;
}

// Finished header strip: one flat chip per tool family. Wide screens show four then "+N"; narrow ones show two then "+N".
const STRIP_WIDE = 4;
const STRIP_NARROW = 2;
function FamilyStrip({ families }: { families: ToolFamily[] }) {
  return (
    <span className="proc-icons" aria-hidden="true">
      {families.slice(0, STRIP_WIDE).map((family) => <i key={family} style={hueStyle(family)}>{toolIcon(family)}</i>)}
      {families.length > STRIP_WIDE ? <b className="more wide">+{families.length - STRIP_WIDE}</b> : null}
      {families.length > STRIP_NARROW ? <b className="more narrow">+{families.length - STRIP_NARROW}</b> : null}
    </span>
  );
}

// The running header clock ticks locally, so it never rerenders the timeline.
function HeaderClock({ createdAt, updatedAt }: { createdAt?: string; updatedAt?: string }) {
  const [mounted] = useState(Date.now);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  const start = Date.parse(createdAt ?? "");
  const elapsed = Number.isFinite(start) ? Math.max(0, Math.max(now, Date.parse(updatedAt ?? "") || 0) - start) : now - mounted;
  return <span className="proc-meta tnum" aria-label={t("process.elapsed", { duration: formatProcessElapsed(elapsed) })}>{formatProcessElapsed(elapsed)}</span>;
}

export type ProcessProps = {
  timeline: ProcessEntry[];
  active: boolean;
  status?: RunStatus;
  waitingKind?: WaitingInput["kind"];
  resource?: string;
  error?: string;
  createdAt?: string;
  updatedAt?: string;
  // The reader's own choice. Without one the header opens while the run works and closes shortly after it ends.
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  renderBody: (text: string, id: string, streaming: boolean) => ReactNode;
  // One clock for the whole run, so a row keeps its timing when the transcript regroups it into another block.
  clock?: EntryClock;
  // Entries that describe the header when this block has no rows of its own (the live status after an interim reply).
  headerEntries?: ProcessEntry[];
  // Lets the host find this block in the DOM.
  blockId?: string;
  // Called with a pending automatic collapse so the host can hold the reader's scroll position.
  onAutoCollapse?: (blockId?: string) => void;
};

export const ProcessTimeline = memo(function ProcessTimeline({
  timeline, active, status, waitingKind, resource, error, createdAt, updatedAt, expanded, onExpandedChange, renderBody, onAutoCollapse, clock: sharedClock, headerEntries, blockId,
}: ProcessProps) {
  useI18n();
  const ownClock = useEntryClock(timeline);
  const clock = sharedClock ?? ownClock;
  const rows = useMemo(() => groupProcessEntries(timeline.filter((entry) => entry.kind === "tool" ? Boolean(entry.step) : Boolean((entry.reasoning?.text ?? entry.text)?.trim()))), [timeline]);
  const hasRows = rows.length > 0 || Boolean(error);
  const peek = active;
  const durationMs = processElapsedMilliseconds(createdAt, updatedAt, false, 0);
  const header = useMemo(() => describeHeader({ status, active, entries: headerEntries ?? timeline, waitingKind, resource, durationMs }), [status, active, timeline, headerEntries, waitingKind, resource, durationMs]);
  const [localTouched, setLocalTouched] = useState<boolean | undefined>(undefined);
  const touched = expanded ?? localTouched;
  // Automatic policy: open while the run works, close 0.7 s after it ends.
  const wantOpen = active && hasRows;
  const [auto, setAuto] = useState(wantOpen);
  const collapse = useRef(onAutoCollapse);
  collapse.current = onAutoCollapse;
  useEffect(() => {
    if (wantOpen) { setAuto(true); return; }
    if (!auto) return;
    collapse.current?.(blockId);
    const timer = setTimeout(() => setAuto(false), 700);
    return () => clearTimeout(timer);
  }, [wantOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  const open = touched ?? auto;
  const toggle = () => { setLocalTouched(!open); onExpandedChange?.(!open); };

  const counted = header.counted;
  const strip = header.state === "done" && !open ? stepFamilies(counted, Infinity) : [];
  const shimmer = active && header.state === "running";
  const lastIndex = rows.length - 1;

  const label = <>
    <Indicator state={header.state} />
    <RollingLabel id={header.id} shimmer={shimmer}>
      <span className="lbl-main">{header.label}</span>
      {header.sub ? <span className={`lbl-sub${header.mono ? " mono" : ""}`}>{header.sub}</span> : null}
    </RollingLabel>
    {strip.length ? <FamilyStrip families={strip} /> : null}
    {header.queue ? <ComputerQueueDetails progress={header.queue} live={active} /> : active ? <HeaderClock createdAt={createdAt} updatedAt={updatedAt} /> : header.duration ? <span className="proc-meta tnum">{header.duration}</span> : null}
  </>;

  return (
    <div className="proc" data-block={blockId} data-state={header.state} data-open={open} data-empty={!hasRows && !active}>
      {hasRows
        ? <button className="proc-head" aria-expanded={open} onClick={toggle}>{label}<ChevronRight className="chev ic" aria-hidden="true" /></button>
        : <div className="proc-head static" role={active ? "status" : undefined}>{label}</div>}
      {hasRows ? (
        <Collapse open={open} className="proc-body">
          <ol className="steps">
            {rows.map((row, index) => {
              const fold = peek && index < lastIndex;
              const enter = !clock.initial.has(row.id);
              if (row.kind === "tools") return <ToolGroup key={row.id} row={row} live={active} peek={peek} fold={fold} enter={enter} clock={clock} />;
              const entry = row.entry;
              if (entry.kind === "reasoning") return <ThinkingRow key={row.id} entry={entry} active={active} fold={fold} enter={enter} clock={clock} />;
              if (entry.kind === "tool") return <ToolRow key={row.id} entry={entry} live={active} fold={fold} enter={enter} clock={clock} />;
              return <ProgressRow key={row.id} entry={entry} fold={fold} enter={enter} streaming={active && index === lastIndex && status === "running"} renderBody={renderBody} />;
            })}
          </ol>
          {error ? <details className="technical-details"><summary>{t("error.details")}</summary><pre>{error}</pre></details> : null}
        </Collapse>
      ) : null}
    </div>
  );
});
