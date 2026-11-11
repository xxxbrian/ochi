import { memo, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  AppWindow,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  Camera,
  CircleAlert,
  CircleDot,
  FolderOpen,
  Hourglass,
  Keyboard,
  LayoutGrid,
  Maximize2,
  Monitor,
  MousePointer2,
  MousePointerClick,
  Move,
  Pause,
  ScanEye,
  TextCursorInput,
} from "lucide-react";
import type { ComputerQueueProgress } from "../../../shared/conversation/computerQueue";
import { computerQueueWaitMilliseconds } from "../../../shared/conversation/computerQueue";
import { computerQueueLabel, formatProcessElapsed, processT } from "../../../shared/i18n/process";
import {
  DESKTOP_HEIGHT as DH,
  DESKTOP_WIDTH as DW,
  computerActionName,
  parseComputerAction,
  permissionDecision,
  queueSlots,
  type ComputerAction,
  type ComputerActionName,
  type Point,
} from "../lib/computerAction";
import { t, useI18n } from "../lib/i18n";
import { isToolFailure } from "../lib/processTimeline";
import type { Step } from "../lib/types";
import { useQueueNow } from "./ComputerQueueDetails";
import { Modal } from "./Modal";
import "./computer.css";

const percent = (value: number, total: number) => `${(Math.min(Math.max(value, 0), total) / total) * 100}%`;
const icons: Record<ComputerActionName, ReactNode> = {
  click: <MousePointerClick size={15} />, move: <MousePointer2 size={15} />, drag: <Move size={15} />,
  scroll: <ArrowUpDown size={15} />, type: <TextCursorInput size={15} />, key: <Keyboard size={15} />,
  screenshot: <Camera size={15} />, observe: <ScanEye size={15} />, windows: <AppWindow size={15} />,
  apps: <LayoutGrid size={15} />,
};
/** Stable hue per name so app tiles keep their colour between renders. */
const hueOf = (name: string) => [...name].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) % 360, 7);
const cursor = "M0 0 l0 22 l6 -6 l5 11 l5 -2 l-5 -11 l9 0z";

function Cursor({ at }: { at: Point }) {
  return <g transform={`translate(${at.x} ${at.y}) scale(2.6)`}><path className="cu-arrow" d={cursor} /></g>;
}

function Chip({ at, children, tone }: { at: Point; children: ReactNode; tone?: "dim" | "below" }) {
  const side = at.x > DW * 0.7 ? "end" : at.x < DW * 0.3 ? "start" : "mid";
  return (
    <span className="cu-chip" data-side={side} data-tone={tone} style={{ left: percent(at.x, DW), top: percent(at.y, DH) }}>
      {children}
    </span>
  );
}

export function Keycaps({ keys }: { keys: string[] }) {
  return (
    <span className="cu-keycaps">
      {keys.map((key, index) => (
        <kbd className="cu-keycap" key={index} style={{ "--i": index } as CSSProperties}>{key}</kbd>
      ))}
    </span>
  );
}

function scrollIcon(direction: "up" | "down" | "left" | "right") {
  const Icon = { up: ArrowUp, down: ArrowDown, left: ArrowLeft, right: ArrowRight }[direction];
  return <Icon size={20} strokeWidth={2.4} />;
}

/** Pointer, path and keyboard marks drawn on the desktop thumbnail. */
function Overlay({ action }: { action: ComputerAction }) {
  const markerId = `cu-arrowhead-${useId().replace(/:/g, "")}`;
  const at = action.point ?? { x: DW / 2, y: DH / 2 };
  switch (action.name) {
    case "click":
      return (
        <>
          <svg className="cu-overlay" viewBox={`0 0 ${DW} ${DH}`} aria-hidden>
            <circle className="cu-ripple" cx={at.x} cy={at.y} r="26" />
            <circle className="cu-ripple cu-ripple-late" cx={at.x} cy={at.y} r="26" />
            <circle className="cu-ring" cx={at.x} cy={at.y} r="26" />
            <path className="cu-cross" d={`M${at.x - 52} ${at.y}h28M${at.x + 24} ${at.y}h28M${at.x} ${at.y - 52}v28M${at.x} ${at.y + 24}v28`} />
            <Cursor at={at} />
          </svg>
          {action.point && <Chip at={at}>{at.x}, {at.y}</Chip>}
        </>
      );
    case "move":
      return (
        <>
          <svg className="cu-overlay" viewBox={`0 0 ${DW} ${DH}`} aria-hidden>
            <path className="cu-trail" d={`M${at.x - 260} ${at.y + 150} Q${at.x - 120} ${at.y - 40} ${at.x} ${at.y}`} />
            <circle className="cu-dot" cx={at.x - 260} cy={at.y + 150} r="9" />
            <Cursor at={at} />
          </svg>
          {action.point && <Chip at={at}>{at.x}, {at.y}</Chip>}
        </>
      );
    case "drag": {
      const to = action.to ?? { x: at.x + 240, y: at.y };
      return (
        <>
          <svg className="cu-overlay" viewBox={`0 0 ${DW} ${DH}`} aria-hidden>
            <defs>
              <marker id={markerId} viewBox="0 0 10 10" refX="7" refY="5" markerWidth="5" markerHeight="5" orient="auto">
                <path d="M1 1L8 5L1 9z" className="cu-arrowhead" />
              </marker>
            </defs>
            <path className="cu-trail" markerEnd={`url(#${markerId})`} d={`M${at.x} ${at.y} Q${(at.x + to.x) / 2} ${Math.max(0, Math.min(at.y, to.y) - 90)} ${to.x} ${to.y}`} />
            <circle className="cu-dot" cx={at.x} cy={at.y} r="12" />
            <circle className="cu-dot cu-dot-end" cx={to.x} cy={to.y} r="12" />
          </svg>
          {action.point && <Chip at={at} tone="dim">{at.x}, {at.y}</Chip>}
          {action.to && <Chip at={to}>{to.x}, {to.y}</Chip>}
        </>
      );
    }
    case "scroll":
      return action.scroll ? (
        <>
          <span className="cu-scroll" data-direction={action.scroll.direction} style={{ left: percent(at.x, DW), top: percent(at.y, DH) }} aria-hidden>
            <i>{scrollIcon(action.scroll.direction)}</i><i>{scrollIcon(action.scroll.direction)}</i><i>{scrollIcon(action.scroll.direction)}</i>
          </span>
          <Chip at={at} tone="below">{scrollLabel(action)}</Chip>
        </>
      ) : null;
    case "type":
      return (
        <span className="cu-typechip">
          <b aria-hidden><TextCursorInput size={12} /></b>
          <code>{(action.text ?? "").slice(0, 80)}</code>
          <i className="cu-caret" />
        </span>
      );
    case "key":
      return <span className="cu-keychip"><Keycaps keys={action.keys ?? []} /></span>;
    default:
      return null;
  }
}

function scrollLabel(action: ComputerAction) {
  const scroll = action.scroll;
  if (!scroll) return "";
  const key = { up: "computer.scrollUp", down: "computer.scrollDown", left: "computer.scrollLeft", right: "computer.scrollRight" }[scroll.direction] as
    "computer.scrollUp";
  return t(key, { count: scroll.clicks });
}

function buttonLabel(button: NonNullable<ComputerAction["button"]>) {
  return t({ left: "computer.buttonLeft", middle: "computer.buttonMiddle", right: "computer.buttonRight", double: "computer.buttonDouble" }[button] as
    "computer.buttonLeft");
}

function metaRows(action: ComputerAction): [string, string][] {
  const rows: [string, string][] = [];
  const point = (value?: Point) => (value ? `${value.x}, ${value.y}` : "");
  if (action.name === "drag") {
    if (action.point) rows.push([t("computer.from"), point(action.point)]);
    if (action.to) rows.push([t("computer.to"), point(action.to)]);
  } else if (action.point) {
    rows.push([t("computer.position"), point(action.point)]);
  }
  if (action.name === "click" && action.button) rows.push([t("computer.button"), buttonLabel(action.button)]);
  if (action.name === "scroll" && action.scroll) rows.push([t("computer.direction"), scrollLabel(action)]);
  if (action.name === "type") rows.push([t("computer.characters"), String([...(action.text ?? "")].length)]);
  if (action.name === "key" && action.keys?.length) rows.push([t("computer.keys"), action.keys.join(" ")]);
  if (action.name === "screenshot" || action.name === "observe") rows.push([t("computer.resolution"), `${DW}×${DH}`]);
  return rows;
}

function ListBody({ action, running }: { action: ComputerAction; running: boolean }) {
  const rows = action.rows ?? [];
  if (running)
    return (
      <div className="cu-list" aria-hidden>
        {[0, 1, 2].map((index) => (
          <div className="cu-row" key={index} style={{ "--i": index } as CSSProperties}>
            <i className="cu-skeleton" style={{ width: 16, height: 16 }} />
            <i className="cu-skeleton" style={{ height: 12, width: `${60 - index * 12}%` }} />
          </div>
        ))}
      </div>
    );
  if (!rows.length) return <p className="cu-empty">{t(action.name === "windows" ? "computer.noWindows" : "computer.noApps")}</p>;
  if (action.name === "apps")
    return (
      <div className="cu-apps">
        {rows.map((row, index) => (
          <span className="cu-app" key={index} data-focused={row.focused || undefined} style={{ "--i": Math.min(index, 8), "--h": hueOf(row.title) } as CSSProperties}>
            <i>{[...row.title][0]}</i>{row.title}
          </span>
        ))}
      </div>
    );
  return (
    <div className="cu-list">
      {rows.map((row, index) => (
        <div className="cu-row" key={index} data-focused={row.focused || undefined} style={{ "--i": Math.min(index, 8) } as CSSProperties}>
          <AppWindow size={15} />
          <span className="cu-row-title">{row.title}</span>
          {row.detail && <small>{row.detail}</small>}
          {row.focused && <em><CircleDot size={12} />{t("computer.focused")}</em>}
        </div>
      ))}
    </div>
  );
}

/** Per-action visual body for an expanded computer tool call. Null for non-action tools. */
export const ComputerActionBody = memo(function ComputerActionBody({ step }: { step: Step }) {
  useI18n();
  const action = useMemo(() => parseComputerAction(step), [step.name, step.arguments, step.output]);
  const [zoom, setZoom] = useState(false);
  if (!action) return null;
  const running = step.status === "running";
  const failed = isToolFailure(step);
  const state = running ? "running" : failed ? "failed" : "done";
  if (action.name === "windows" || action.name === "apps")
    return <div className="cu-body" data-tool={action.name}><ListBody action={action} running={running} /></div>;
  const screen = (
    <>
      {step.screenshot ? <img src={step.screenshot} alt="" draggable={false} loading="lazy" /> : <span className="cu-blank" aria-hidden />}
      <Overlay action={action} />
      {(action.name === "screenshot" || action.name === "observe") && (
        <>
          <span className="cu-brackets" aria-hidden><i /><i /><i /><i /></span>
          {running && <span className="cu-scan" aria-hidden />}
        </>
      )}
      {failed && <span className="cu-failed"><CircleAlert size={13} />{t("status.failed")}</span>}
    </>
  );
  const rows = metaRows(action);
  return (
    <div className="cu-body" data-tool={action.name} data-s={state}>
      {step.screenshot ? (
        <button className="cu-screen cu-screen-button" aria-label={t("process.viewScreenshot")} onClick={() => setZoom(true)}>
          {screen}
          <span className="cu-zoom" aria-hidden><Maximize2 size={13} /></span>
        </button>
      ) : (
        <div className="cu-screen">{screen}</div>
      )}
      <div className="cu-meta">
        <div className="cu-meta-head">
          <i>{icons[action.name]}</i>
          <b>{t(`computer.act.${action.name}` as "computer.act.click")}</b>
          <span className="cu-state" data-s={state}>
            {running ? t("status.inProgress") : failed ? t("status.failed") : t("status.completed")}
          </span>
        </div>
        {rows.map(([label, value]) => (
          <div className="cu-kv" key={label}><span>{label}</span><code>{value}</code></div>
        ))}
        {action.name === "type" && action.text && (
          <div className="cu-kv cu-kv-wide"><span>{t("computer.content")}</span><code>{action.text.slice(0, 400)}</code></div>
        )}
      </div>
      {zoom && step.screenshot && (
        <Modal title={t("process.screenshot")} onClose={() => setZoom(false)} wide fullscreen>
          <img className="cu-full-image" src={step.screenshot} alt={t("process.result")} />
        </Modal>
      )}
    </div>
  );
});

/* -------------------------------------------------------------- permission */

export function PermissionResult({ decision }: { decision: "once" | "conversation" | "denied" }) {
  useI18n();
  const denied = decision === "denied";
  return (
    <div className="cu-done" role="status" data-denied={denied || undefined}>
      <span className="cu-tick" aria-hidden>
        {denied ? (
          <svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17" /></svg>
        ) : (
          <svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
        )}
      </span>
      <span>
        <b>{t(denied ? "permission.deniedTitle" : "permission.allowedTitle")}</b>
        <small>
          {t(denied ? "permission.deniedHint" : decision === "once" ? "permission.once" : "permission.scopeConversation")}
        </small>
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------- queue */

export type QueueCardProps = {
  resource: "desktop" | "project";
  status: "waiting" | "paused" | "acquired";
  title: string;
  subtitle: string;
  /** Formatted elapsed wait. Omitted when no time is known. */
  elapsed?: string;
  /** Requests ahead of the user. Omitted when the count is unknown. */
  ahead?: number;
  footer?: string;
  onCancel?: () => void;
  cancelLabel?: string;
  /** Compact variant drawn over the live desktop. */
  overlay?: boolean;
};

/** Keeps departing slots mounted long enough to play their exit, and reports when the line advanced. */
function useDeparting(ahead: number | undefined) {
  const [shown, setShown] = useState(ahead ?? 0);
  const previous = useRef(ahead ?? 0);
  const [advanced, setAdvanced] = useState(false);
  useEffect(() => {
    if (ahead === undefined) return;
    const before = previous.current;
    previous.current = ahead;
    if (ahead >= before) {
      setAdvanced(false);
      return void setShown(ahead);
    }
    setShown(before);
    setAdvanced(true);
    const timer = setTimeout(() => { setShown(ahead); setAdvanced(false); }, 520);
    return () => clearTimeout(timer);
  }, [ahead]);
  return { drawn: ahead === undefined ? 0 : Math.max(shown, ahead), advanced };
}

/** Presentational FIFO queue card shared by tool steps and the live desktop. */
export function QueueCard(props: QueueCardProps) {
  useI18n();
  const { resource, status, ahead, elapsed, footer, onCancel, overlay } = props;
  const { drawn, advanced } = useDeparting(ahead);
  const slots = queueSlots(drawn);
  const done = status === "acquired";
  const ResourceIcon = resource === "project" ? FolderOpen : Monitor;
  const aheadLabel = ahead === undefined ? "" : processT("computer.ahead", { count: ahead });
  return (
    <section className="cu-queue" data-status={status} data-res={resource} data-overlay={overlay || undefined}>
      <div className="cu-queue-head">
        <span className="cu-queue-icon" aria-hidden>
          {done ? <svg viewBox="0 0 24 24" className="cu-tick-svg"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg> : status === "paused" ? <Pause size={17} /> : <Hourglass size={17} />}
        </span>
        <div className="cu-queue-text"><b>{props.title}</b><small>{props.subtitle}</small></div>
        {elapsed && (
          <span className="cu-queue-time">
            <small>{t(done ? "computer.queueTook" : "computer.queueWaited")}</small>
            <span>{elapsed}</span>
          </span>
        )}
      </div>
      <div className="cu-track" role="img" aria-label={aheadLabel || props.subtitle} data-done={done || undefined} data-advance={advanced || undefined}>
        <span className="cu-rail" aria-hidden><i /></span>
        {Array.from({ length: slots.shown }, (_, index) => (
          <span
            className="cu-slot"
            key={index}
            data-leaving={index >= (ahead ?? 0) || undefined}
            data-tip={t("computer.queueSlot")}
            style={{ "--h": (index * 67 + 205) % 360 } as CSSProperties}
            aria-hidden
          ><i /></span>
        ))}
        {slots.overflow > 0 && ahead !== undefined && <span className="cu-slot-more">+{ahead - slots.shown}</span>}
        <span className="cu-slot cu-slot-you" data-tip={t("computer.queueYouTip")} aria-hidden><i>{t("computer.queueYou")}</i></span>
        <span className="cu-arrowline" aria-hidden />
        <span className="cu-resource" aria-hidden><ResourceIcon size={14} /><small>{t(resource === "project" ? "computer.resProject" : "computer.resDesktop")}</small></span>
      </div>
      {(footer || onCancel) && !done && (
        <div className="cu-queue-foot">
          <span>{footer}</span>
          {onCancel && <button type="button" className="btn ghost sm" onClick={onCancel}>{props.cancelLabel}</button>}
        </div>
      )}
    </section>
  );
}

/** Queue card for a `computer_queue` tool step (anonymous slots, server-sampled wait). */
export const ComputerQueueCard = memo(function ComputerQueueCard({ progress, live = false }: {
  progress: ComputerQueueProgress; live?: boolean;
}) {
  useI18n();
  const now = useQueueNow(progress, live);
  const acquired = progress.status === "acquired";
  const ahead = acquired ? undefined : progress.waitingAhead;
  const subtitle = acquired
    ? t("computer.queueReady")
    : progress.status === "paused"
      ? t("computer.queuePausedHint")
      : progress.waitingAhead === 0
        ? t("computer.queueNext")
        : processT("computer.ahead", { count: progress.waitingAhead });
  return (
    <QueueCard
      resource={progress.resource}
      status={progress.status}
      title={computerQueueLabel(progress)}
      subtitle={subtitle}
      ahead={ahead}
      elapsed={acquired ? undefined : formatProcessElapsed(computerQueueWaitMilliseconds(progress, now))}
      footer={acquired ? undefined : t("computer.queueFooter")}
    />
  );
});

/**
 * Computer-specific body for a tool step, or null to use the generic body.
 * `hidesOutput` is set when the body already presents everything in the raw output.
 */
export function computerStepPart(step: Step, queue: ComputerQueueProgress | null): { node: ReactNode; hidesOutput: boolean } | null {
  if (queue) return { node: <ComputerQueueCard progress={queue} live={step.status === "running"} />, hidesOutput: true };
  if (step.name === "request_computer_permission") {
    const decision = permissionDecision(step);
    return decision ? { node: <PermissionResult decision={decision} />, hidesOutput: true } : null;
  }
  const name = computerActionName(step.name);
  if (!name) return null;
  return { node: <ComputerActionBody step={step} />, hidesOutput: name !== "screenshot" && name !== "observe" };
}
