import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type SyntheticEvent,
} from "react";
import {
  ArrowDown,
  Check,
  Copy,
  LoaderCircle,
  RotateCcw,
  Volume2,
} from "lucide-react";
import { isActiveStatus, userFacingRunError } from "../lib/api";
import type { Message, Snapshot } from "../lib/types";
import { chatMessageKey, projectChatMessages } from "../lib/chatProjection";
import { markdownImageUrls } from "../lib/markdown";
import { MarkdownMessage } from "./MarkdownMessage";
import { UserMessage } from "./UserMessage";
import { HistoryProcess } from "./HistoryProcess";
import { FileCards } from "./FileCards";
import { effortLabel } from "./Composer";
import { WaitingInputCard } from "./WaitingInputCard";
import "./chat.css";

type Props = {
  messages: Message[];
  snapshot: Snapshot | null;
  sessionId: string | null;
  onLoadOlder?: () => void;
  olderLoading?: boolean;
  onRetry?: (message: Message) => void;
  onEdit?: (message: Message) => void;
  onResume: (runId: string, answer: string) => Promise<void>;
};

const MessageActions = memo(function MessageActions({
  message,
  onRetry,
}: {
  message: Message;
  onRetry?: (message: Message) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* Copy is unavailable in an insecure browser context. */
    }
  }
  function speak() {
    if (speaking) {
      window.speechSynthesis.cancel();
      setSpeaking(false);
      return;
    }
    const utterance = new SpeechSynthesisUtterance(
      message.content.replace(/[#*`]/g, ""),
    );
    utterance.lang = "zh-CN";
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
    setSpeaking(true);
  }
  return (
    <div className="message-actions">
      <button
        className="icon-button"
        onClick={() => void copy()}
        aria-label={copied ? "已复制" : "复制"}
        title="复制"
      >
        {copied ? <Check size={15} /> : <Copy size={15} />}
      </button>
      {message.role === "assistant" && "speechSynthesis" in window && (
        <button
          className={`icon-button ${speaking ? "is-active" : ""}`}
          onClick={speak}
          aria-label={speaking ? "停止朗读" : "朗读"}
          title="朗读"
        >
          <Volume2 size={16} />
        </button>
      )}
      {onRetry && (
        <button
          className="icon-button"
          onClick={() => onRetry(message)}
          aria-label="重新生成"
          title="重新生成"
        >
          <RotateCcw size={15} />
        </button>
      )}
    </div>
  );
});

const HistoryMessage = memo(function HistoryMessage({
  message,
  snapshot,
  onRetry,
  onEdit,
  processOpen,
  onProcessOpen,
}: {
  message: Message;
  snapshot?: Snapshot | null;
  onRetry?: (message: Message) => void;
  onEdit?: (message: Message) => void;
  processOpen?: boolean;
  onProcessOpen?: (runId: string, expanded: boolean) => void;
}) {
  const process =
    message.role === "assistant" &&
    message.run_id &&
    ((message.step_count ?? 0) > 0 ||
      message.has_reasoning ||
      message.has_process ||
      message.run_status ||
      (snapshot?.run_id === message.run_id && Boolean(snapshot.error)));
  const files = message.attachments;
  const visibleContent = snapshot?.output ?? message.content;
  const embeddedImages = useMemo(
    () => markdownImageUrls(message.content),
    [message.content],
  );
  const separateFiles = files?.filter(
    (file) => !file.mime_type.startsWith("image/") || !embeddedImages.has(file.url),
  );
  const embeddedFiles = files?.filter(
    (file) => file.mime_type.startsWith("image/") && embeddedImages.has(file.url),
  );
  return (
    <article className={`message-row ${message.role}`}>
      {process ? <HistoryProcess
        runId={message.run_id!}
        stepCount={message.step_count ?? 0}
        hasReasoning={message.has_reasoning}
        hasProcess={message.has_process}
        status={message.run_status}
        snapshot={snapshot}
        output={message.content}
        createdAt={message.run_created_at}
        updatedAt={message.run_updated_at}
        expanded={processOpen}
        onExpandedChange={(expanded) => onProcessOpen?.(message.run_id!, expanded)}
        renderBody={(text, _id, streaming) => <MarkdownMessage message={{ ...message, content: text }} isStreaming={streaming} />}
      /> : null}
      {message.role === "user" && (
        <FileCards
          files={message.attachments}
          variant="attachment"
        />
      )}
      {message.role === "user" ? (
        <UserMessage message={message} onEdit={onEdit} onRetry={onRetry} />
      ) : !process && visibleContent ? <MarkdownMessage message={message} isStreaming={snapshot?.status === "running"} /> : null}
      {message.role !== "user" && (
        <>
          <FileCards files={separateFiles} />
          <FileCards files={embeddedFiles} compactImages />
        </>
      )}
      {message.role !== "user" && visibleContent && !isActiveStatus(snapshot?.status ?? message.run_status ?? "completed") && <div className="message-footer">
        <MessageActions message={message} onRetry={onRetry} />
        {message.role === "assistant" && message.model_name && (
          <span className="message-model" title={`${message.model_name}${message.effort ? ` · ${effortLabel(message.effort)}` : ""}`}>
            {message.model_name}
            {message.effort ? ` · ${effortLabel(message.effort)}` : ""}
          </span>
        )}
      </div>}
    </article>
  );
});
const History = memo(function History({
  messages,
  latestSnapshot,
  onRetry,
  onEdit,
  processExpansion,
  onProcessOpen,
}: {
  messages: Message[];
  latestSnapshot?: Snapshot | null;
  onRetry?: (message: Message) => void;
  onEdit?: (message: Message) => void;
  processExpansion: Record<string, boolean>;
  onProcessOpen: (runId: string, expanded: boolean) => void;
}) {
  let lastUser = -1,
    lastAssistant = -1;
  messages.forEach((message, index) => {
    if (message.role === "user") lastUser = index;
    if (message.role === "assistant" && message.created_at) lastAssistant = index;
  });
  const lastRetry = lastAssistant > lastUser ? lastAssistant : lastUser;
  return messages.map((message, index) => (
    <HistoryMessage
      key={chatMessageKey(message)}
      message={message}
      snapshot={
        message.run_id === latestSnapshot?.run_id ? latestSnapshot : null
      }
      onRetry={index === lastRetry && message.run_id ? onRetry : undefined}
      onEdit={index === lastUser ? onEdit : undefined}
      processOpen={message.run_id ? processExpansion[message.run_id] : undefined}
      onProcessOpen={onProcessOpen}
    />
  ));
});

export function MessageList({
  messages,
  snapshot,
  sessionId,
  onLoadOlder,
  olderLoading,
  onRetry,
  onEdit,
  onResume,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const shouldStick = useRef(true);
  const inspectingDetails = useRef(false);
  const userScrollUntil = useRef(0);
  const scrollFrame = useRef<number | null>(null);
  const prependScroll = useRef<{
    height: number;
    top: number;
    firstId: string;
  } | null>(null);
  const [showJump, setShowJump] = useState(false);
  const [processExpansion, setProcessExpansion] = useState<Record<string, boolean>>({});
  const layoutHeld = useRef(false);
  const onProcessOpen = useCallback((runId: string, expanded: boolean) => {
    setProcessExpansion((current) => current[runId] === expanded ? current : { ...current, [runId]: expanded });
  }, []);
  const projectedMessages = useMemo(() => projectChatMessages(messages, snapshot), [messages, snapshot]);
  useLayoutEffect(() => {
    shouldStick.current = true;
    inspectingDetails.current = false;
    prependScroll.current = null;
    setShowJump(false);
    setProcessExpansion({});
  }, [sessionId]);
  const scrollToLatest = useCallback(() => {
    if (!shouldStick.current || layoutHeld.current || scrollFrame.current !== null) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = null;
      const node = scrollRef.current;
      if (node && shouldStick.current && !layoutHeld.current) node.scrollTop = node.scrollHeight;
    });
  }, []);
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const preserve = (event: Event) => {
      layoutHeld.current = (event as CustomEvent).detail === "begin";
      if (layoutHeld.current && scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
      if (layoutHeld.current) scrollFrame.current = null;
    };
    const selectionChanged = () => {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && (node.contains(selection.anchorNode) || node.contains(selection.focusNode))) pauseForDetails();
    };
    node.addEventListener("ochi:transcript-layout", preserve);
    document.addEventListener("selectionchange", selectionChanged);
    return () => {
      node.removeEventListener("ochi:transcript-layout", preserve);
      document.removeEventListener("selectionchange", selectionChanged);
      layoutHeld.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    const previous = prependScroll.current,
      node = scrollRef.current;
    if (previous && node && messages[0]?.id !== previous.firstId) {
      node.scrollTop = previous.top + node.scrollHeight - previous.height;
      prependScroll.current = null;
    }
    scrollToLatest();
  }, [messages, snapshot?.output, snapshot?.status, scrollToLatest]);
  useEffect(() => {
    const column = columnRef.current;
    if (!column) return;
    const observer = new ResizeObserver(scrollToLatest);
    observer.observe(column);
    return () => {
      observer.disconnect();
      if (scrollFrame.current !== null)
        cancelAnimationFrame(scrollFrame.current);
      scrollFrame.current = null;
    };
  }, [scrollToLatest]);
  function userScrolling() {
    inspectingDetails.current = false;
    if (scrollRef.current) delete scrollRef.current.dataset.readerPaused;
    userScrollUntil.current = performance.now() + 400;
  }
  function pauseForDetails() {
    // Expansion changes height before ResizeObserver runs. Do not jump away
    // from what the user just opened, including browser scroll anchoring.
    inspectingDetails.current = true;
    if (scrollRef.current) scrollRef.current.dataset.readerPaused = "true";
    shouldStick.current = false;
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = null;
    setShowJump(true);
  }
  function onUserScroll(event: SyntheticEvent<HTMLDivElement>) {
    if (event.target instanceof Element && event.target.closest(".process-viewport, .run-transcript.is-archived .run-work-surface")) pauseForDetails();
    else userScrolling();
  }
  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    userScrollUntil.current = performance.now() + 400;
    if (event.target instanceof Element && event.target.closest(".process-toggle, .thinking-part-toggle, .step-summary, .technical-details > summary, .process-viewport, .run-transcript.is-archived .run-work-surface"))
      pauseForDetails();
    else if (event.target === event.currentTarget) userScrolling();
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const navigationKey = ["Home", "End", "PageUp", "PageDown", "ArrowUp", "ArrowDown", " "].includes(event.key);
    const innerProcess = event.target instanceof Element && event.target.closest(".process-viewport, .run-transcript.is-archived .run-work-surface");
    if (innerProcess && navigationKey) {
      pauseForDetails();
      return;
    }
    const details = event.target instanceof Element && event.target.closest(".process-toggle, .thinking-part-toggle, .step-summary, .technical-details > summary, .process-viewport");
    if (details && (event.key === "Enter" || event.key === " ")) pauseForDetails();
    else if (navigationKey) {
      userScrolling();
      if (["Home", "PageUp", "ArrowUp"].includes(event.key)) shouldStick.current = false;
    }
  }
  function onScroll() {
    const node = scrollRef.current;
    if (!node) return;
    const nearBottom =
      node.scrollHeight - node.scrollTop - node.clientHeight < 96;
    if (nearBottom && !inspectingDetails.current) shouldStick.current = true;
    else if (performance.now() < userScrollUntil.current)
      shouldStick.current = false;
    if (!shouldStick.current) node.dataset.readerPaused = "true";
    else delete node.dataset.readerPaused;
    setShowJump(!shouldStick.current);
  }
  function jumpDown() {
    inspectingDetails.current = false;
    const node = scrollRef.current;
    if (node) delete node.dataset.readerPaused;
    if (node)
      node.scrollTo({
        top: node.scrollHeight,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      });
    shouldStick.current = true;
    setShowJump(false);
  }
  return (
    <div className="messages-region">
      <div
        className="messages-scroll"
        role="region"
        aria-label="消息列表"
        tabIndex={0}
        ref={scrollRef}
        onScroll={onScroll}
        onWheel={onUserScroll}
        onTouchMove={onUserScroll}
        onPointerDownCapture={onPointerDown}
        onKeyDownCapture={onKeyDown}
      >
        <div className="messages-column" ref={columnRef}>
          {onLoadOlder && (
            <button
              className="older-messages"
              onClick={() => {
                shouldStick.current = false;
                const node = scrollRef.current;
                if (node && messages[0])
                  prependScroll.current = {
                    height: node.scrollHeight,
                    top: node.scrollTop,
                    firstId: messages[0].id,
                  };
                onLoadOlder();
              }}
              disabled={olderLoading}
            >
              {olderLoading ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                "加载更早的消息"
              )}
            </button>
          )}
          <History
            messages={projectedMessages}
            latestSnapshot={snapshot}
            onRetry={onRetry}
            onEdit={onEdit}
            processExpansion={processExpansion}
            onProcessOpen={onProcessOpen}
          />
          {snapshot?.waiting_input && snapshot.status === "waiting_user" && (
            <WaitingInputCard
              key={`${snapshot.run_id}:${snapshot.waiting_input.kind ?? "question"}:${snapshot.waiting_input.question}`}
              waiting={snapshot.waiting_input}
              runId={snapshot.run_id}
              onResume={onResume}
            />
          )}
          {snapshot?.status === "failed" && (
            <div className="run-error" role="alert">
              {userFacingRunError(
                snapshot.error,
                Boolean(snapshot.artifacts?.length),
              )}
            </div>
          )}
          {messages.length === 0 && !snapshot && (
            <div className="empty-state">
              <h2>你想探索什么？</h2>
            </div>
          )}
        </div>
      </div>
      {showJump && (
        <button
          className="jump-latest icon-button"
          aria-label="回到最新消息"
          onClick={jumpDown}
        >
          <ArrowDown size={18} />
        </button>
      )}
    </div>
  );
}
