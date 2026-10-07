import { ChevronRight, LoaderCircle, MessageCircle } from "lucide-react";
import { lazy, memo, Suspense, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ProcessEntry } from "../lib/types";
import { groupProcessEntries, lastMatching, type ProcessRow } from "../lib/processTimeline";
import { StepCard, StepList, toolIcon } from "./ProcessSteps";
import { ThinkingContent } from "./ThinkingDetails";
import "./process-timeline.css";

const MarkdownContent = lazy(() => import("./MarkdownContent"));

export const PublicProgress = memo(function PublicProgress({ text, preview = false, streaming = false }: { text: string; preview?: boolean; active?: boolean; streaming?: boolean }) {
  return (
    <div className={preview ? "process-progress-preview" : "process-progress"}>
      {!preview ? <span className="process-progress-icon" aria-hidden="true"><MessageCircle size={14} /></span> : null}
      <div className="process-progress-text">
        <Suspense fallback={<p className="thinking-plain">{text}</p>}>
          <MarkdownContent content={text} isStreaming={streaming} />
        </Suspense>
      </div>
    </div>
  );
});

const ToolGroup = memo(function ToolGroup({ row, expanded, expansion, onExpandedChange, onStepExpandedChange }: {
  row: Extract<ProcessRow, { kind: "tools" }>;
  expanded?: boolean;
  expansion: Record<string, boolean>;
  onExpandedChange: (id: string, expanded: boolean) => void;
  onStepExpandedChange: (id: string, expanded: boolean) => void;
}) {
  const steps = row.entries.flatMap((entry) => entry.step ? [entry.step] : []);
  const open = expanded ?? steps.some((step) => expansion[step.id]);
  const running = steps.some((step) => step.status === "running");
  const noun = { terminal: "个命令", files: "次文件操作", browser: "次网页操作", computer: "次电脑操作", search: "次搜索", image: "次生图", tool: "个工具" }[row.family];
  return (
    <div className={`process-tool-group ${open ? "is-expanded" : ""}`} data-process-id={row.id}>
      <button className="process-group-toggle step-summary" aria-expanded={open} onClick={() => onExpandedChange(row.id, !open)}>
        <span className="process-group-icon" aria-hidden="true">
          {running ? <LoaderCircle size={14} className="spin" /> : toolIcon(row.family)}
        </span>
        <span className="process-group-title">{running ? row.family === "tool" ? "正在调用" : "正在执行" : row.family === "tool" ? "已调用" : "已执行"} {steps.length} {noun}</span>
        <ChevronRight size={14} className="process-group-chevron" />
      </button>
      {open ? <div className="process-group-children"><StepList steps={steps} expansion={expansion} onExpandedChange={onStepExpandedChange} /></div> : null}
    </div>
  );
});

const TimelineEntry = memo(function TimelineEntry({ entry, active, workingProgress, expanded, onExpandedChange }: { entry: ProcessEntry; active: boolean; workingProgress: boolean; expanded?: boolean; onExpandedChange: (id: string, expanded: boolean) => void }) {
  let content;
  if (entry.kind === "tool" && entry.step) content = <StepCard step={entry.step} expanded={expanded} onExpandedChange={onExpandedChange} />;
  else if (entry.kind === "progress" && entry.text?.trim()) content = <PublicProgress text={entry.text} active={workingProgress} streaming={active && Boolean(entry.pending)} />;
  else if (entry.kind === "reasoning" && entry.reasoning?.text.trim()) content = <ThinkingContent parts={[entry.reasoning]} active={active} />;
  else return null;
  return <div className="process-timeline-entry" data-process-id={entry.id}>{content}</div>;
});

export const ProcessTimeline = memo(function ProcessTimeline({
  timeline,
  active = false,
  working = active,
  error,
  bounded = true,
}: {
  timeline: ProcessEntry[];
  active?: boolean;
  working?: boolean;
  error?: string;
  bounded?: boolean;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const contents = useRef<HTMLDivElement>(null);
  const followLatest = useRef(active);
  const lastScrollTop = useRef(0);
  const readingAnchor = useRef<{ id: string; top: number } | null>(null);
  const [stepExpansion, setStepExpansion] = useState<Record<string, boolean>>({});
  const [groupExpansion, setGroupExpansion] = useState<Record<string, boolean>>({});
  const changeStepExpansion = useCallback((id: string, expanded: boolean) => {
    setStepExpansion((current) => ({ ...current, [id]: expanded }));
  }, []);
  const changeGroupExpansion = useCallback((id: string, expanded: boolean) => {
    setGroupExpansion((current) => ({ ...current, [id]: expanded }));
  }, []);
  const rows = useMemo(() => groupProcessEntries(timeline), [timeline]);
  const latestProgressId = lastMatching(timeline, (entry) => entry.kind === "progress" && Boolean(entry.text?.trim()))?.id;

  function captureAnchor() {
    const node = viewport.current;
    if (!node) return;
    const bounds = node.getBoundingClientRect();
    for (const row of node.querySelectorAll<HTMLElement>("[data-process-id]")) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom > bounds.top && rect.top < bounds.bottom) {
        readingAnchor.current = { id: row.dataset.processId!, top: rect.top - bounds.top };
        return;
      }
    }
    readingAnchor.current = null;
  }

  useLayoutEffect(() => {
    const node = viewport.current;
    const content = contents.current;
    if (!node || !content) return;
    const observer = new ResizeObserver(() => {
      if (followLatest.current) node.scrollTop = node.scrollHeight;
      else if (readingAnchor.current) {
        const anchor = readingAnchor.current;
        const row = [...node.querySelectorAll<HTMLElement>("[data-process-id]")].find((element) => element.dataset.processId === anchor.id);
        if (row) node.scrollTop += row.getBoundingClientRect().top - node.getBoundingClientRect().top - anchor.top;
      }
      lastScrollTop.current = node.scrollTop;
      captureAnchor();
    });
    observer.observe(content);
    if (active) node.scrollTop = node.scrollHeight;
    lastScrollTop.current = node.scrollTop;
    captureAnchor();
    return () => observer.disconnect();
  }, []);

  function onScroll() {
    const node = viewport.current;
    if (!node) return;
    const moved = node.scrollTop - lastScrollTop.current;
    if (moved < -1) followLatest.current = false;
    else if (moved > 1) followLatest.current = node.scrollHeight - node.clientHeight - node.scrollTop < 24;
    lastScrollTop.current = node.scrollTop;
    captureAnchor();
  }

  function pauseForExpansion() {
    // Reading an older row must not be undone by the next token or resize.
    followLatest.current = false;
    captureAnchor();
  }

  return (
    <div
      className={`process-viewport${bounded ? "" : " is-unbounded"}`}
      ref={viewport}
      onScroll={onScroll}
      onWheel={(event) => { if (event.deltaY < 0) pauseForExpansion(); }}
      onKeyDown={(event) => { if (["ArrowUp", "PageUp", "Home"].includes(event.key)) pauseForExpansion(); }}
      onClickCapture={(event) => { if (event.target instanceof Element && event.target.closest("button, summary")) pauseForExpansion(); }}
      role="region"
      aria-label="处理过程"
      tabIndex={0}
    >
      <div className="process-timeline" ref={contents}>
        {rows.map((row) => {
          if (row.kind === "tools") return <ToolGroup key={row.id} row={row} expanded={groupExpansion[row.id]} expansion={stepExpansion} onExpandedChange={changeGroupExpansion} onStepExpandedChange={changeStepExpansion} />;
          return <TimelineEntry key={row.id} entry={row.entry} active={active} workingProgress={working && row.id === latestProgressId} expanded={row.entry.step ? Boolean(stepExpansion[row.entry.step.id]) : undefined} onExpandedChange={changeStepExpansion} />;
        })}
        {error ? <details className="technical-details"><summary>错误详情</summary><pre>{error}</pre></details> : null}
      </div>
    </div>
  );
});
