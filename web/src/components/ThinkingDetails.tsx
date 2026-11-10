import { useI18n } from "../lib/i18n";
import { lazy, memo, Suspense, useMemo, useRef } from "react";
import type { ReasoningPart } from "../lib/types";
import { formatReasoningDisplay } from "../lib/runPresentation";
import { useStickToEnd } from "../hooks/useStickToEnd";
import "./process.css";

const MarkdownContent = lazy(() => import("./MarkdownContent"));

// Reasoning text in a bounded box. While streaming it is a five-line window that follows the newest
// text and fades at the top; once finished it is a taller, normally scrollable block.
export const ThinkingContent = memo(function ThinkingContent({ part, active = false }: { part: ReasoningPart; active?: boolean }) {
  useI18n();
  const content = useMemo(() => formatReasoningDisplay(part.text), [part.text]);
  const live = active && !part.done;
  const box = useRef<HTMLDivElement>(null);
  useStickToEnd(box, content, live);
  return (
    <div className={`think-box${live ? " live" : ""}`} ref={box} tabIndex={0}>
      <div className="think-text">
        <Suspense fallback={<p className="thinking-plain">{content}</p>}>
          <MarkdownContent content={content} isStreaming={live} />
        </Suspense>
      </div>
    </div>
  );
});
