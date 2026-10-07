import { lazy, memo, Suspense, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Lightbulb } from "lucide-react";
import type { ReasoningPart } from "../lib/types";
import { formatReasoningDisplay } from "../lib/runPresentation";
import "./thinking.css";

const MarkdownContent = lazy(() => import("./MarkdownContent"));

export function OchiActivityMark({ working = true }: { working?: boolean }) {
  return (
    <span className={`ochi-activity-mark${working ? " is-working" : ""}`} aria-hidden="true">
      <span className="ochi-mark-face">
        <span className="ochi-mark-eyes">
          <span className="ochi-mark-eye" />
          <span className="ochi-mark-eye" />
        </span>
      </span>
    </span>
  );
}

const ThinkingPart = memo(function ThinkingPart({ part, active }: { part: ReasoningPart; active: boolean }) {
  const content = useMemo(() => formatReasoningDisplay(part.text), [part.text]);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  const contents = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = contents.current;
    if (!node) return;
    const measure = () => {
      const line = Number.parseFloat(getComputedStyle(node).lineHeight) || 24;
      setLong(node.scrollHeight > line * 4 + 1);
    };
    measure();
    // The clipped body stops resizing at four lines; observe natural content.
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return <div className={`thinking-part${open ? " is-expanded" : ""}`}>
    <div className="thinking-part-body">
      <div className="thinking-part-content" ref={contents}>
        <Suspense fallback={<p className="thinking-plain">{content}</p>}>
          <MarkdownContent content={content} isStreaming={active && !part.done} />
        </Suspense>
      </div>
    </div>
    {long || open ? <button className="thinking-part-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "收起思考" : "展开思考"}</button> : null}
  </div>;
});

export const ThinkingContent = memo(function ThinkingContent({
  parts,
  active = false,
}: {
  parts: ReasoningPart[];
  active?: boolean;
}) {
  return (
    <div className="thinking-content">
      <span className="thinking-rail" aria-hidden="true"><Lightbulb size={14} /></span>
      <div className="thinking-parts">
        {parts.map((part) =>
          part.text.trim() ? (
            <ThinkingPart part={part} active={active} key={part.id} />
          ) : null,
        )}
      </div>
    </div>
  );
});
