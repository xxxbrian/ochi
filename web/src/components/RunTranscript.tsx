import { memo, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { ProcessEntry, RunStatus, WaitingInput } from "../lib/types";
import { isActiveStatus } from "../lib/api";
import { transcriptPlan } from "../lib/runPresentation";
import { ProcessDetails, ProcessSummary } from "./ProcessDetails";
import "./run-transcript.css";

type Props = {
  timeline: ProcessEntry[];
  output: string;
  status?: RunStatus;
  waitingKind?: WaitingInput["kind"];
  resource?: string;
  error?: string;
  createdAt?: string;
  updatedAt?: string;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  renderBody: (text: string, id: string, streaming: boolean) => ReactNode;
};

// Each portal keeps its own host and React identity when the completed process
// is grouped into one bounded viewport. Moving the host never remounts Markdown.
const TranscriptSlot = memo(function TranscriptSlot({ id, order, destination, publicText, children }: {
  id: string; order: number; destination: RefObject<HTMLDivElement | null>; publicText?: boolean; children: ReactNode;
}) {
  const [host] = useState(() => typeof document === "undefined" ? null : document.createElement("div"));
  useLayoutEffect(() => {
    const target = destination.current;
    if (!host || !target) return;
    host.className = publicText ? "run-transcript-slot run-public-block" : "run-transcript-slot run-process-slot";
    host.dataset.transcriptId = id;
    host.dataset.slotOrder = String(order);
    if (publicText) host.dataset.publicEntry = id;
    const next = [...target.children].find((node) => node !== host && Number((node as HTMLElement).dataset.slotOrder) > order) ?? null;
    if (host.parentElement !== target || host.nextSibling !== next) target.insertBefore(host, next);
  }, [host, id, order, destination, publicText]);
  useLayoutEffect(() => () => { host?.remove(); }, [host]);
  return host ? createPortal(children, host, id) : <div data-transcript-id={id}>{children}</div>;
});

type ReadingAnchor = { node: HTMLElement; top: number; scroll: HTMLElement };

function selectionInside(root: HTMLElement) {
  const selection = window.getSelection();
  return Boolean(selection && !selection.isCollapsed && (root.contains(selection.anchorNode) || root.contains(selection.focusNode)));
}

function scrollContainer(node: HTMLElement) {
  return node.closest<HTMLElement>(".messages-scroll, .workspace-page-scroll");
}

function readerPaused(scroll: HTMLElement | null) {
  if (!scroll) return false;
  return scroll.dataset.readerPaused === "true" ||
    (scroll.matches(".workspace-page-scroll") && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight > 96);
}

export const RunTranscript = memo(function RunTranscript({ timeline, output, status, waitingKind, resource, error, createdAt, updatedAt, expanded, onExpandedChange, renderBody }: Props) {
  const plan = useMemo(() => transcriptPlan(timeline, output, status), [timeline, output, status]);
  const root = useRef<HTMLDivElement>(null);
  const work = useRef<HTMLDivElement>(null);
  const answer = useRef<HTMLDivElement>(null);
  const [rolledUp, setRolledUp] = useState(() => plan.canRollUp);
  const [localOpen, setLocalOpen] = useState(false);
  const [answerReady, setAnswerReady] = useState(false);
  const open = expanded ?? localOpen;
  const reading = useRef(false);
  const attempted = useRef(plan.canRollUp);
  const seenLive = useRef(isActiveStatus(status));
  const anchor = useRef<ReadingAnchor | null>(null);
  const focusedAnswer = useRef<HTMLElement | null>(null);
  const heldScroll = useRef<HTMLElement | null>(null);
  const releaseFrame = useRef<number | null>(null);
  const releasingScroll = useRef<HTMLElement | null>(null);
  const answerRequested = useRef(false);
  const active = isActiveStatus(status);
  const archived = rolledUp && plan.canRollUp;

  function preserveAnswer() {
    const node = root.current;
    if (!node) return;
    if (releaseFrame.current !== null) cancelAnimationFrame(releaseFrame.current);
    releaseFrame.current = null;
    const scroll = scrollContainer(node);
    if (!scroll) return;
    const candidates = [...node.querySelectorAll<HTMLElement>("[data-public-entry]")].filter((element) => plan.finalIds.has(element.dataset.publicEntry!) || element.dataset.publicEntry === "output");
    const focused = document.activeElement;
    focusedAnswer.current = focused instanceof HTMLElement && candidates.some((candidate) => candidate.contains(focused)) ? focused : null;
    const bounds = scroll.getBoundingClientRect();
    for (const candidate of candidates) {
      const blocks = [...candidate.querySelectorAll<HTMLElement>(".markdown > *, .markdown-loading")];
      const visible = blocks.find((block) => { const rect = block.getBoundingClientRect(); return rect.bottom > bounds.top && rect.top < bounds.bottom; });
      if (visible || candidate.getBoundingClientRect().bottom > bounds.top) {
        const element = visible ?? candidate;
        anchor.current = { node: element, top: element.getBoundingClientRect().top, scroll };
        break;
      }
    }
    heldScroll.current = scroll;
    releasingScroll.current = scroll;
    scroll.dispatchEvent(new CustomEvent("ochi:transcript-layout", { detail: "begin" }));
  }

  useLayoutEffect(() => {
    if (status !== "completed") {
      if (active) seenLive.current = true;
      attempted.current = false;
      if (rolledUp) setRolledUp(false);
      return;
    }
    if (!plan.canRollUp || attempted.current) return;
    attempted.current = true;
    const node = root.current;
    const scroll = node ? scrollContainer(node) : null;
    if (seenLive.current && node && (reading.current || open || readerPaused(scroll) || selectionInside(node))) {
      setAnswerReady(true);
      return;
    }
    preserveAnswer();
    setRolledUp(true);
  }, [status, plan.canRollUp, open, rolledUp]);

  useLayoutEffect(() => {
    if (!heldScroll.current) return;
    const saved = anchor.current;
    if (answerRequested.current && archived) {
      answer.current?.firstElementChild?.scrollIntoView({ block: "start", behavior: "auto" });
      answerRequested.current = false;
    } else if (saved?.node.isConnected) saved.scroll.scrollTop += saved.node.getBoundingClientRect().top - saved.top;
    if (focusedAnswer.current?.isConnected && document.activeElement !== focusedAnswer.current) focusedAnswer.current.focus({ preventScroll: true });
    focusedAnswer.current = null;
    anchor.current = null;
    const scroll = heldScroll.current;
    heldScroll.current = null;
    releaseFrame.current = requestAnimationFrame(() => {
      scroll.dispatchEvent(new CustomEvent("ochi:transcript-layout", { detail: "end" }));
      releaseFrame.current = null;
      releasingScroll.current = null;
    });
  }, [archived, open]);
  useLayoutEffect(() => () => {
    if (releaseFrame.current !== null) cancelAnimationFrame(releaseFrame.current);
    releasingScroll.current?.dispatchEvent(new CustomEvent("ochi:transcript-layout", { detail: "end" }));
  }, []);

  function changeOpen(next: boolean) {
    reading.current = true;
    preserveAnswer();
    setLocalOpen(next);
    onExpandedChange?.(next);
  }
  function showAnswer() {
    reading.current = false;
    setAnswerReady(false);
    preserveAnswer();
    answerRequested.current = true;
    setLocalOpen(false);
    onExpandedChange?.(false);
    setRolledUp(true);
  }
  function noteReading(target: EventTarget | null) {
    if (target instanceof Element && target.closest(".run-transcript-slot button, .run-transcript-slot summary, .process-viewport")) reading.current = true;
  }
  const hasPublic = plan.rows.some((row) => row.kind === "public") || Boolean(plan.fallback);
  return <div className={`run-transcript${archived ? " is-archived" : ""}${open ? " is-open" : ""}`} ref={root}
    onPointerDownCapture={(event) => noteReading(event.target)} onWheelCapture={(event) => noteReading(event.target)}
    onKeyDownCapture={(event) => { if (["Enter", " ", "ArrowUp", "PageUp", "Home"].includes(event.key)) noteReading(event.target); }}>
    {(active || plan.hasWork || error) ? <div className="run-transcript-summary">
      <ProcessSummary timeline={timeline} active={active} status={status} waitingKind={waitingKind} resource={resource} hasOutput={hasPublic}
        expanded={open} onExpandedChange={archived ? changeOpen : undefined} createdAt={createdAt} updatedAt={updatedAt} />
      {answerReady && <button className="run-answer-ready" onClick={showAnswer}>查看答复</button>}
    </div> : null}
    <div className="run-work-surface" hidden={archived && !open}>
      <div className="run-work-contents" ref={work} />
    </div>
    <div className="run-answer-surface" ref={answer} />
    {plan.rows.map((row, order) => <TranscriptSlot key={row.id} id={row.id} order={order} publicText={row.kind === "public"}
      destination={archived && plan.finalIds.has(row.id) ? answer : work}>
      {row.kind === "public" ? renderBody(row.entry.text!, row.id, status === "running" && row.id === plan.rows.at(-1)?.id)
        : <ProcessDetails timeline={row.entries} active={active} status={status} compact bounded={!archived} />}
    </TranscriptSlot>)}
    {plan.fallback ? <TranscriptSlot key="output" id="output" order={plan.rows.length} publicText destination={archived ? answer : work}>
      {renderBody(plan.fallback, "output", status === "running")}
    </TranscriptSlot> : null}
    {error && !hasPublic ? <p className="form-error">{error}</p> : null}
  </div>;
});
