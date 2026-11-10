import { t, useI18n } from "../lib/i18n";
import {
  AppWindow, BookOpen, Brain, CalendarClock, Camera, ChevronRight, CircleAlert, Command, ExternalLink, FilePen, FilePlus, FileText,
  FolderTree, Globe2, Hand, Hourglass, ImagePlus, Keyboard, Layers, LayoutGrid, Lightbulb, LockKeyhole, MessageSquare, Monitor,
  MousePointer2, MousePointerClick, Move, Puzzle, ScanEye, Search, ShieldCheck, Terminal, TextCursorInput, Wrench, type LucideIcon,
} from "lucide-react";
import { memo, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { ProcessEntry, Step } from "../lib/types";
import {
  browserNeedsUser, familyHue, formatStepDuration, groupProcessEntries, isToolFailure, parseSearchOutput, stepState, toolFamily, toolInfo, toolSubject,
  type ProcessRow, type StepState, type ToolFamily,
} from "../lib/processTimeline";
import { formatProcessElapsed } from "../lib/processTiming";
import { stepMotion } from "../lib/stepMotion";
import type { EntryClock } from "../lib/entryClock";
import { computerQueueProgress } from "../../../shared/conversation/computerQueue";
import { computerQueueLabel } from "../../../shared/i18n/process";
import { ComputerQueueDetails } from "./ComputerQueueDetails";
import { ThinkingContent } from "./ThinkingDetails";
import { ToolBody } from "./ToolBodies";
import { Favicon } from "./SearchSources";
import "./process.css";

/* ---------------------------------------------------------------- icons & hue */

const familyIcons: Record<ToolFamily, LucideIcon> = {
  terminal: Terminal, files: FileText, search: Search, browser: AppWindow, computer: Monitor, image: ImagePlus, tool: Wrench, ask: Hand,
};
const toolIcons: Record<string, LucideIcon> = {
  files_list: FolderTree, files_read: FileText, files_write: FilePen, files_copy: FileText, publish_file: FilePlus,
  web_search: Search, web_fetch: ExternalLink, isolated_research: BookOpen,
  browser_goto: Globe2, browser_observe: ScanEye, browser_snapshot: ScanEye, browser_click: MousePointerClick, browser_type: TextCursorInput,
  browser_screenshot: Camera, browser_resume: LockKeyhole, browser_status: ScanEye,
  computer_observe: ScanEye, computer_screenshot: Camera, computer_click: MousePointerClick, computer_type: Keyboard,
  computer_key: Command, computer_scroll: MousePointer2, computer_move: Move, computer_drag: Move,
  computer_windows: AppWindow, computer_apps: LayoutGrid, computer_queue: Hourglass, request_computer_permission: ShieldCheck,
  memory_search: Brain, memory_save: Brain, memory_delete: Brain, schedule_create: CalendarClock, schedule_update: CalendarClock,
  schedule_list: CalendarClock, skills_read: BookOpen, skills_list: BookOpen, request_user_input: Hand,
};

export function familyIcon(family: ToolFamily, size = 13) {
  const Icon = familyIcons[family];
  return <Icon size={size} strokeWidth={2} />;
}
export const toolIcon = (kind: string) => familyIcon((kind in familyIcons ? kind : "tool") as ToolFamily, 11);

function nameIcon(name: string, state: StepState) {
  if (state === "error") return <CircleAlert className="ic" />;
  const Icon = toolIcons[name] ?? (name.startsWith("mcp_") ? Puzzle : familyIcons[toolFamily(name)]);
  return <Icon className="ic" />;
}

export const hueStyle = (family: ToolFamily | "thought"): CSSProperties => ({ "--fh": family === "thought" ? familyHue.tool : familyHue[family] } as CSSProperties);

/* ---------------------------------------------------------------- disclosure */

// Rises at once, falls after `delay`: a finished step lingers so the result can be seen.
export function useSettledOpen(want: boolean, delay = 1100) {
  const [open, setOpen] = useState(want);
  useEffect(() => {
    if (want) { setOpen(true); return; }
    const timer = setTimeout(() => setOpen(false), delay);
    return () => clearTimeout(timer);
  }, [want, delay]);
  return open;
}

// The user's own toggle wins over the automatic policy for as long as the row lives.
function useDisclosure(want: boolean, delay: number) {
  const settled = useSettledOpen(want, delay);
  const [touched, setTouched] = useState<boolean | undefined>(undefined);
  const open = touched ?? settled;
  return { open, touched: touched !== undefined, toggle: () => setTouched(!open) };
}

const reducedMotion = () => typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

// Height-animated disclosure. Content mounts only while open (or closing), so expensive detail stays lazy.
export function Collapse({ open, className = "", children }: { open: boolean; className?: string; children: ReactNode }) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      let inner = 0;
      const outer = requestAnimationFrame(() => { inner = requestAnimationFrame(() => setShown(true)); });
      return () => { cancelAnimationFrame(outer); cancelAnimationFrame(inner); };
    }
    setShown(false);
    const timer = setTimeout(() => setMounted(false), reducedMotion() ? 0 : 360);
    return () => clearTimeout(timer);
  }, [open]);
  if (!mounted) return null;
  return <div className={`collapse ${className}`.trim()} data-open={shown}><div className="collapse-in">{children}</div></div>;
}

export function LiveTime({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, []);
  return <span className="st-time tnum">{formatStepDuration(Math.max(0, now - since))}</span>;
}

/* ------------------------------------------------------------------- one row */

const checkMark = <svg className="st-check" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="6" /><path pathLength="1" d="M3.4 6.2l1.9 1.9 3.3-3.9" /></svg>;

// The process header's running indicator (lab "bars"): bars breathe in place. Running rows keep their own icon (see stepMotion).
export function RunningBars({ count = 3 }: { count?: number }) {
  return <span className="ind-bars" aria-hidden="true">{Array.from({ length: count }, (_, index) => <i key={index} />)}</span>;
}

type ItemState = StepState | "idle";

function StepItem({ id, kind, tool = "", state, family, group = false, enter, fold, open, onToggle, hue, icon, plain = false, check = false, label, title, titleTone, shimmer = false, sub, mono = false, strip, time, children }: {
  id: string;
  kind: "reasoning" | "tool" | "group";
  tool?: string;
  state: ItemState;
  family: string;
  group?: boolean;
  enter: boolean;
  fold: boolean;
  open: boolean;
  onToggle: () => void;
  hue?: CSSProperties;
  icon: ReactNode;
  plain?: boolean;
  check?: boolean;
  label?: string;
  title: ReactNode;
  titleTone?: "bad";
  shimmer?: boolean;
  sub?: ReactNode;
  mono?: boolean;
  strip?: ReactNode;
  time?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className={`step${group ? " group" : ""}${enter ? " step-in" : ""}`} data-process-id={id} data-kind={kind} data-status={state} data-family={family} data-motion={state === "running" ? stepMotion(tool, family) : undefined} data-open={open} data-fold={fold}>
      <div className="step-row">
        <span className="st-dot" role={label ? "img" : undefined} aria-label={label}>
          <span className={`st-tile${plain ? " plain" : ""}${group ? " stack" : ""}`} style={hue}>{icon}</span>
          {check ? checkMark : null}
        </span>
        <div className="st-main">
          <button className="st-head" aria-expanded={open} onClick={onToggle}>
            <span className={`st-title${shimmer ? " shimmer" : ""}${titleTone === "bad" ? " bad" : ""}`}>{title}</span>
            <span className={`st-sub${mono ? " mono" : ""}`}>{sub}</span>
            {strip}
            {time}
            <ChevronRight className="chev ic" aria-hidden="true" />
          </button>
          <Collapse open={open}>{children}</Collapse>
        </div>
      </div>
    </li>
  );
}

function leadSentence(text: string) {
  const plain = text.replace(/[*_`#>]+/g, "").trim();
  const first = plain.split(/(?<=[。！？.!?\n])/)[0]?.trim() ?? "";
  return first.length > 120 ? `${first.slice(0, 120)}…` : first;
}

export const ThinkingRow = memo(function ThinkingRow({ entry, active, fold, enter, clock }: {
  entry: ProcessEntry; active: boolean; fold: boolean; enter: boolean; clock: EntryClock;
}) {
  useI18n();
  const part = entry.reasoning!;
  const running = active && !part.done;
  const { open, toggle } = useDisclosure(running, 900);
  const time = clock.times.get(entry.id);
  const duration = time?.t1 !== undefined ? formatProcessElapsed(time.t1 - time.t0) : undefined;
  const title = running ? t("process.thinking") : part.kind === "summary" ? t("process.reasoningSummary") : duration ? t("process.thoughtFor", { duration }) : t("process.thought");
  return (
    <StepItem id={entry.id} kind="reasoning" state={running ? "running" : "idle"} family="reasoning" enter={enter} fold={fold} open={open} onToggle={toggle}
      hue={hueStyle("thought")} icon={<Lightbulb className="ic" />} title={title} shimmer={running}
      sub={running ? undefined : leadSentence(part.text)} time={running && time ? <LiveTime since={time.t0} /> : undefined}>
      <div className="st-body"><ThinkingContent part={part} active={active} /></div>
    </StepItem>
  );
});

export function stepWantsOpen(step: Step, live: boolean) {
  const state = stepState(step);
  if (state === "error") return true;
  if (state === "waiting") return true;
  if (!live) return false;
  return state === "running" && (step.name === "web_search" || ["terminal", "computer", "browser", "image"].includes(toolFamily(step.name)));
}

function failedExit(step: Step) {
  if (step.status !== "completed" || toolFamily(step.name) !== "terminal" || !step.output?.includes("exit_code")) return false;
  try { const code = JSON.parse(step.output).exit_code; return typeof code === "number" && code !== 0; } catch { return false; }
}

export const ToolRow = memo(function ToolRow({ entry, live, fold, enter, clock }: {
  entry: ProcessEntry; live: boolean; fold: boolean; enter: boolean; clock?: EntryClock;
}) {
  useI18n();
  const step = entry.step!;
  const info = toolInfo(step.name);
  const queue = computerQueueProgress(step);
  const needsUser = browserNeedsUser(step);
  const search = useMemo(() => parseSearchOutput(step), [step.name, step.arguments, step.output]);
  const failed = isToolFailure(step) || failedExit(step);
  const state: StepState = failed ? "error" : stepState(step);
  const { open, toggle } = useDisclosure(stepWantsOpen(step, live), 1100);
  const target = toolSubject(step);
  const since = clock?.times.get(entry.id)?.t0;
  const title = queue ? computerQueueLabel(queue) : failed ? t("process.toolFailed", { tool: info.label }) : state === "running" || state === "waiting" ? info.running : info.label;
  const aria = queue ? title : needsUser ? t("process.awaitingVerification") : state === "running" ? t("status.inProgress") : failed ? t("status.failed") : t("status.completed");
  const sub = queue ? <ComputerQueueDetails progress={queue} live={step.status === "running"} />
    : search ? <span className="st-sites">{search.results.slice(0, 3).map((result) => <Favicon key={result.url} url={result.url} />)}<span>{t("process.results", { count: search.results.length })}</span></span>
    : needsUser ? t("process.awaitingVerification") : target;
  const time = state === "running" && since ? <LiveTime since={since} />
    : state === "waiting" ? <span className="st-time"><span className="dot-live" /></span>
    : typeof step.duration_ms === "number" ? <span className="st-time tnum">{formatStepDuration(step.duration_ms)}</span> : null;
  return (
    <StepItem id={entry.id} kind="tool" tool={step.name} state={state} family={info.kind} enter={enter} fold={fold} open={open} onToggle={toggle}
      hue={hueStyle(info.kind)} icon={nameIcon(step.name, state)} check={state === "done"} label={aria}
      title={title} titleTone={failed ? "bad" : undefined} shimmer={state === "running"} sub={sub} mono={!queue && !search && !needsUser} time={time}>
      <ToolBody step={step} kind={info.kind} queue={queue} needsUser={needsUser} failed={failed} />
    </StepItem>
  );
});

export const ProgressRow = memo(function ProgressRow({ entry, fold, enter, streaming, renderBody }: {
  entry: ProcessEntry; fold: boolean; enter: boolean; streaming: boolean; renderBody: (text: string, id: string, streaming: boolean) => ReactNode;
}) {
  return (
    <li className={`step${enter ? " step-in" : ""}`} data-process-id={entry.id} data-kind="progress" data-status={streaming ? "running" : "done"} data-family="progress" data-fold={fold}>
      <div className="step-row">
        <span className="st-dot"><span className="st-tile plain"><MessageSquare className="ic" /></span></span>
        <div className="st-main"><div className="st-prog">{renderBody(entry.text ?? "", entry.id, streaming)}</div></div>
      </div>
    </li>
  );
});

/* --------------------------------------------------------------------- group */

const familyName = (family: ToolFamily) => t(`process.family.${family}`);

export const ToolGroup = memo(function ToolGroup({ row, live, peek, fold, enter, clock }: {
  row: Extract<ProcessRow, { kind: "tools" }>; live: boolean; peek: boolean; fold: boolean; enter: boolean; clock: EntryClock;
}) {
  useI18n();
  const steps = row.entries.flatMap((entry) => (entry.step ? [entry.step] : []));
  const running = steps.some((step) => step.status === "running");
  const waiting = steps.some((step) => stepState(step) === "waiting");
  const failed = steps.some((step) => isToolFailure(step));
  const { open, toggle } = useDisclosure(live && (running || waiting), 1500);
  const state: StepState = waiting ? "waiting" : running ? "running" : failed ? "error" : "done";
  const families = [...new Set(steps.map((step) => toolFamily(step.name)))];
  const counts = families.map((family) => `${familyName(family)} ${steps.filter((step) => toolFamily(step.name) === family).length}`).join(" · ");
  const total = steps.reduce((sum, step) => sum + (step.duration_ms ?? 0), 0);
  const title = running ? t("process.group.running", { count: steps.length }) : t("process.group.done", { count: steps.length });
  return (
    <StepItem id={row.id} kind="group" group state={state} family="group" enter={enter} fold={fold} open={open} onToggle={toggle}
      icon={<Layers className="ic" />} title={title} shimmer={running} sub={counts}
      strip={<span className="st-strip" aria-hidden="true">{families.map((family) => <i key={family} style={hueStyle(family)}>{toolIcon(family)}</i>)}</span>}
      time={<span className="st-time tnum">{running || !total ? "" : formatStepDuration(total)}</span>}>
      <ol className="steps nested">
        {row.entries.map((entry, index) => (
          <ToolRow key={entry.id} entry={entry} live={live} fold={peek && (fold || index < row.entries.length - 1)} enter={!clock.initial.has(entry.id)} clock={clock} />
        ))}
      </ol>
    </StepItem>
  );
});

/* ---------------------------------------------------------------- plain list */

// Tool calls without a run around them (the admin run drawer): the same rows, no live behaviour.
export const StepList = memo(function StepList({ steps }: { steps: Step[] }) {
  useI18n();
  const entries = useMemo(() => steps.map((step, index): ProcessEntry => ({ id: step.id, seq: index, source_id: "", round_id: "", kind: "tool", step })), [steps]);
  const rows = useMemo(() => groupProcessEntries(entries), [entries]);
  const clock = useMemo<EntryClock>(() => ({ initial: new Set(entries.map((entry) => entry.id)), times: new Map() }), [entries]);
  return (
    <ol className="steps">
      {rows.map((row) => row.kind === "tools"
        ? <ToolGroup key={row.id} row={row} live={false} peek={false} fold={false} enter={false} clock={clock} />
        : <ToolRow key={row.id} entry={row.entry} live={false} fold={false} enter={false} clock={clock} />)}
    </ol>
  );
});
