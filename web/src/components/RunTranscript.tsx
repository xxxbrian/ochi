import { t, useI18n } from "../lib/i18n";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import type { ProcessEntry, RunStatus, WaitingInput } from "../lib/types";
import { isActiveStatus, userFacingRunError } from "../lib/api";
import { orderedProcessEntries } from "../lib/processTimeline";
import { transcriptRows } from "../lib/runPresentation";
import { useEntryClock, type EntryClock } from "../lib/entryClock";
import { ProcessTimeline } from "./ProcessTimeline";
import "./process.css";

type Props = {
  timeline: ProcessEntry[];
  output: string;
  status?: RunStatus;
  waitingKind?: WaitingInput["kind"];
  resource?: string;
  error?: string;
  errorCode?: string;
  hasArtifacts?: boolean;
  createdAt?: string;
  updatedAt?: string;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  renderBody: (text: string, id: string, streaming: boolean) => ReactNode;
};

// How a process block relates to the run: the block still working, one that an interim reply closed,
// the single block a finished run folds everything into, or the bare live status after an interim reply.
export type BlockRole = "live" | "settled" | "folded" | "tail";
export type TranscriptItem =
  | { key: string; kind: "prose"; entry: ProcessEntry; streaming: boolean }
  | { key: string; kind: "process"; role: BlockRole; entries: ProcessEntry[] };

const hasText = (entry: ProcessEntry) => entry.kind === "progress" && Boolean(entry.text?.trim());
const isWork = (entry: ProcessEntry) => entry.kind === "tool" ? Boolean(entry.step) : entry.kind === "reasoning" && Boolean(entry.reasoning?.text.trim());

/**
 * Lays one run out in order. While it works (and when it did not finish with an answer) interim replies are plain
 * prose and every stretch of thinking and tool calls between them is its own progress block. A completed run with
 * a final answer folds all of that into one block above the answer.
 */
export function planTranscript(entries: ProcessEntry[], status?: RunStatus, output = "") {
  const ordered = orderedProcessEntries(entries);
  const progress = ordered.filter(hasText);
  const terminalProse = status === "failed" || status === "interrupted" || status === "cancelled";
  const marked = progress.some((entry) => entry.final || entry.pending);
  let lastWork = -1;
  ordered.forEach((entry, index) => { if (entry.kind !== "progress") lastWork = index; });
  const answers = terminalProse ? [] : marked ? progress.filter((entry) => entry.final || entry.pending)
    : progress.filter((entry) => ordered.indexOf(entry) > lastWork);
  const answerIds = new Set(answers.map((entry) => entry.id));
  const rail = ordered.filter((entry) => entry.kind !== "progress" || (hasText(entry) && !answerIds.has(entry.id)));
  const rows = transcriptRows(ordered);
  const last = ordered.at(-1);
  const fallback = progress.length ? "" : output;
  const prose = (entry: ProcessEntry): TranscriptItem => ({ key: entry.id, kind: "prose", entry, streaming: status === "running" && entry === last });
  const folded = status === "completed" && answers.length > 0 && rail.some(isWork);

  let items: TranscriptItem[];
  if (folded) {
    const first = rows.find((row) => row.kind === "process");
    items = [{ key: first?.id ?? "process:fold", kind: "process", role: "folded", entries: rail }, ...answers.map(prose)];
  } else {
    items = rows.map((row, index): TranscriptItem => row.kind === "public" ? prose(row.entry)
      : { key: row.id, kind: "process", role: index === rows.length - 1 ? "live" : "settled", entries: row.entries });
    if (isActiveStatus(status) && items.at(-1)?.kind !== "process") items.push({ key: "process:tail", kind: "process", role: "tail", entries: [] });
  }
  return { items, folded, ordered, fallback, last, work: ordered.filter(isWork) };
}

// A settled block's rows keep their identity while later tokens stream, so its memoised timeline does not rerender.
function stabilise(items: TranscriptItem[], previous: Map<string, TranscriptItem>) {
  return items.map((item) => {
    const before = previous.get(item.key);
    if (item.kind !== "process" || before?.kind !== "process") return item;
    const same = before.role === item.role && before.entries.length === item.entries.length && before.entries.every((entry, index) => entry === item.entries[index]);
    return same ? before : item;
  });
}

function blockTimes(entries: ProcessEntry[], clock: EntryClock) {
  let from = Infinity;
  let to = 0;
  for (const entry of entries) {
    const time = clock.times.get(entry.id);
    if (!time) return {};
    from = Math.min(from, time.t0);
    to = Math.max(to, time.t1 ?? time.t0);
  }
  return entries.length ? { createdAt: new Date(from).toISOString(), updatedAt: new Date(to).toISOString() } : {};
}

const reducedMotion = () => typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
const FOLD_MS = 360;

function scrollParent(node: HTMLElement) {
  return node.closest<HTMLElement>(".scroller, .messages-scroll, .workspace-page-scroll");
}

export const RunTranscript = memo(function RunTranscript({ timeline, output, status, waitingKind, resource, error, errorCode, hasArtifacts = false, createdAt, updatedAt, expanded, onExpandedChange, renderBody }: Props) {
  useI18n();
  const root = useRef<HTMLDivElement>(null);
  const plan = useMemo(() => planTranscript(timeline, status, output), [timeline, status, output]);
  const clock = useEntryClock(plan.work);
  const known = useRef(new Map<string, TranscriptItem>());
  const items = useMemo(() => stabilise(plan.items, known.current), [plan.items]);
  useEffect(() => { known.current = new Map(items.map((item) => [item.key, item])); }, [items]);
  // Items present at the first render are history; later ones fade in.
  const initial = useRef<Set<string> | null>(null);
  initial.current ??= new Set(items.map((item) => item.key));

  // Folding: the blocks and interim replies that merge into the single block collapse away instead of vanishing.
  const [shown, setShown] = useState(items);
  const [departing, setDeparting] = useState<TranscriptItem[] | null>(null);
  if (shown !== items) {
    setShown(items);
    if (plan.folded && !reducedMotion() && shown.some((item) => item.kind === "process" && item.role !== "folded")) {
      const keys = new Set(items.map((item) => item.key));
      if (shown.some((item) => !keys.has(item.key))) setDeparting(shown);
    }
  }
  useEffect(() => {
    if (!departing) return;
    const timer = setTimeout(() => setDeparting(null), FOLD_MS + 40);
    return () => clearTimeout(timer);
  }, [departing]);
  const rendered = useMemo(() => {
    if (!departing) return items.map((item) => ({ item, leaving: false }));
    const current = new Map(items.map((item) => [item.key, item]));
    const seen = new Set<string>();
    const merged = departing.map((old) => {
      const item = current.get(old.key);
      if (item) seen.add(old.key);
      return { item: item ?? old, leaving: !item };
    });
    const fresh = items.filter((item) => !seen.has(item.key)).map((item) => ({ item, leaving: false }));
    // A block with no earlier position (interim replies folding into a fresh block) leads; a late answer trails.
    return [...fresh.filter(({ item }) => item.kind === "process"), ...merged, ...fresh.filter(({ item }) => item.kind === "prose")];
  }, [items, departing]);

  const active = isActiveStatus(status);
  const failed = status === "failed" || status === "interrupted";
  const failureMessage = error || errorCode || failed ? userFacingRunError(error, hasArtifacts, errorCode) : "";
  const primary = [...items].reverse().find((item) => item.kind === "process")?.key;
  const firstBlock = items.find((item) => item.kind === "process")?.key;

  // When a block folds away above text the reader has scrolled to, keep that text where it is.
  const holdReading = useCallback((blockId?: string) => {
    const proc = blockId ? [...(root.current?.querySelectorAll<HTMLElement>(".proc[data-block]") ?? [])].find((node) => node.dataset.block === blockId) : null;
    let node = proc?.closest(".run-item")?.nextElementSibling ?? null;
    while (node && (node as HTMLElement).dataset.leaving === "true") node = node.nextElementSibling;
    const scroll = proc ? scrollParent(proc) : null;
    if (!(node instanceof HTMLElement) || !scroll) return;
    if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 96) return;
    if (node.getBoundingClientRect().top > scroll.getBoundingClientRect().bottom) return;
    const top = node.getBoundingClientRect().top;
    const until = performance.now() + 900;
    scroll.dispatchEvent(new CustomEvent("ochi:transcript-layout", { detail: "begin" }));
    const follow = () => {
      if (!node.isConnected) return;
      const delta = node.getBoundingClientRect().top - top;
      if (delta) scroll.scrollTop += delta;
      if (performance.now() < until) requestAnimationFrame(follow);
      else scroll.dispatchEvent(new CustomEvent("ochi:transcript-layout", { detail: "end" }));
    };
    requestAnimationFrame(follow);
  }, []);

  const block = (item: Extract<TranscriptItem, { kind: "process" }>, leaving: boolean) => {
    const own = item.key === primary && !leaving;
    const live = item.role === "live" || item.role === "tail";
    const wholeRun = item.role === "folded" || item.role === "tail" || (item.role === "live" && item.key === firstBlock);
    // Blocks that an interim reply closed read as finished work; only the block carrying the run's end shows its failure or stop.
    const blockStatus = item.role === "settled" ? "completed" : status;
    return <ProcessTimeline timeline={item.entries} headerEntries={item.role === "tail" ? plan.ordered : undefined} blockId={item.key}
      active={live && active} status={blockStatus} waitingKind={waitingKind} resource={resource}
      {...(wholeRun ? { createdAt, updatedAt } : blockTimes(item.entries, clock))}
      clock={clock} expanded={own ? expanded : undefined} onExpandedChange={own ? onExpandedChange : undefined}
      renderBody={renderBody} onAutoCollapse={holdReading} />;
  };

  return (
    <div className="run-transcript" ref={root}>
      {rendered.map(({ item, leaving }) => (
        <div className="run-item" key={item.key} data-leaving={leaving || undefined}>
          <div className={`run-item-in${initial.current!.has(item.key) ? "" : " run-enter"}`}>
            {item.kind === "prose"
              ? <div className="run-public-block" data-public-entry={item.entry.id}>{renderBody(item.entry.text!, item.entry.id, item.streaming)}</div>
              : block(item, leaving)}
          </div>
        </div>
      ))}
      {plan.fallback ? <div className="run-item"><div className="run-item-in"><div className="run-public-block" data-public-entry="output">{renderBody(plan.fallback, "output", status === "running")}</div></div></div> : null}
      {failureMessage ? <p className="run-error" role="alert"><CircleAlert className="ic" aria-hidden="true" />{failureMessage}</p> : null}
    </div>
  );
});
