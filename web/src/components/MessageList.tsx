import { t, useI18n, getLocale } from "../lib/i18n";
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
import { ArrowDown, Check, Copy, RotateCw, Volume2 } from "lucide-react";
import { isActiveStatus } from "../lib/api";
import type { Message, Snapshot } from "../lib/types";
import { chatMessageKey, projectChatMessages } from "../lib/chatProjection";
import { markdownImageUrls } from "../lib/markdown";
import { publicReply } from "../lib/runPresentation";
import { MarkdownMessage } from "./MarkdownMessage";
import { UserMessage } from "./UserMessage";
import { HistoryProcess } from "./HistoryProcess";
import { FileCards } from "./FileCards";
import { effortLabel } from "../lib/reasoningLabels";
import { WaitingInputCard } from "./WaitingInputCard";
import "./thread.css";
import { LoadingDots } from "./ui/Loading";

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

function messageRunStatus(message?: Message, snapshot?: Snapshot | null) {
  if (message?.run_status && !isActiveStatus(message.run_status)) return message.run_status;
  return snapshot?.status ?? message?.run_status;
}

function durationText(message: Message) {
  const start = Date.parse(message.run_created_at ?? "");
  const end = Date.parse(message.run_updated_at ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "";
  const seconds = Math.max(1, Math.round((end - start) / 1000));
  return seconds < 60 ? t("message.seconds", { n: seconds }) : t("message.minutes", { m: Math.floor(seconds / 60), s: seconds % 60 });
}

const MessageActions = memo(function MessageActions({
  message,
  onRetry,
}: {
  message: Message;
  onRetry?: (message: Message) => void;
}) {
  useI18n();
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
    const utterance = new SpeechSynthesisUtterance(message.content.replace(/[#*`]/g, ""));
    utterance.lang = getLocale();
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
    setSpeaking(true);
  }
  const meta = [
    message.role === "assistant" ? message.model_name : "",
    message.role === "assistant" && message.effort ? effortLabel(message.effort) : "",
    message.role === "assistant" ? durationText(message) : "",
  ].filter(Boolean).join(" · ");
  return (
    <div className="ai-actions">
      <button className={`icon-btn sm${copied ? " flash" : ""}`} onClick={() => void copy()} aria-label={copied ? t("common.copied") : t("common.copy")} title={t("common.copy")}>
        {copied ? <Check className="ic" /> : <Copy className="ic" />}
      </button>
      {message.role === "assistant" && "speechSynthesis" in window && (
        <button className="icon-btn sm" aria-pressed={speaking} onClick={speak} aria-label={speaking ? t("message.stopSpeech") : t("message.readAloud")} title={t("message.readAloud")}>
          <Volume2 className="ic" />
        </button>
      )}
      {onRetry && (
        <button className="icon-btn sm" onClick={() => onRetry(message)} aria-label={t("message.regenerate")} title={t("message.regenerate")}>
          <RotateCw className="ic" />
        </button>
      )}
      {meta && <span className="ai-meta tnum" title={meta}>{meta}</span>}
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
  useI18n();
  const process =
    message.role === "assistant" &&
    message.run_id &&
    ((message.step_count ?? 0) > 0 ||
      message.has_reasoning ||
      message.has_process ||
      message.run_status ||
      (snapshot?.run_id === message.run_id && Boolean(snapshot.error)));
  const files = message.attachments;
  const runStatus = messageRunStatus(message, snapshot);
  const terminalMessage = message.run_status && !isActiveStatus(message.run_status);
  const visibleContent = terminalMessage && message.content.trim() ? message.content
    : snapshot && !isActiveStatus(runStatus) ? publicReply(snapshot)
    : snapshot ? publicReply(snapshot) : message.content;
  const embeddedImages = useMemo(() => markdownImageUrls(message.content), [message.content]);
  const separateFiles = files?.filter((file) => !file.mime_type.startsWith("image/") || !embeddedImages.has(file.url));
  const embeddedFiles = files?.filter((file) => file.mime_type.startsWith("image/") && embeddedImages.has(file.url));
  if (message.role === "user")
    return (
      <UserMessage
        message={message}
        onEdit={onEdit}
        onRetry={onRetry}
        attachments={message.attachments?.length ? <div className="attach-row"><FileCards files={message.attachments} variant="attachment" /></div> : null}
      />
    );
  return (
    <article className="ai-row">
      {process ? <HistoryProcess
        runId={message.run_id!}
        stepCount={message.step_count ?? 0}
        hasReasoning={message.has_reasoning}
        hasProcess={message.has_process}
        status={message.run_status}
        runError={message.run_error}
        runErrorCode={message.run_error_code}
        hasArtifacts={Boolean(message.attachments?.length || snapshot?.artifacts?.length)}
        snapshot={snapshot}
        output={message.content}
        createdAt={message.run_created_at}
        updatedAt={message.run_updated_at}
        expanded={processOpen}
        onExpandedChange={(expanded) => onProcessOpen?.(message.run_id!, expanded)}
        renderBody={(text, _id, streaming) => <MarkdownMessage message={{ ...message, content: text }} isStreaming={streaming} />}
      /> : null}
      {!process && visibleContent ? <MarkdownMessage message={{ ...message, content: visibleContent }} isStreaming={runStatus === "running"} /> : null}
      <FileCards files={separateFiles} />
      <FileCards files={embeddedFiles} compactImages />
      {visibleContent && !isActiveStatus(runStatus) && <MessageActions message={{ ...message, content: visibleContent }} onRetry={onRetry} />}
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
  useI18n();
  let lastUser = -1,
    lastAssistant = -1;
  messages.forEach((message, index) => {
    if (message.role === "user") lastUser = index;
    if (message.role === "assistant" && message.created_at) lastAssistant = index;
  });
  const lastRetry = lastAssistant > lastUser ? lastAssistant : lastUser;
  // A turn is a user message plus the assistant messages that answer it.
  const turns: { index: number; message: Message }[][] = [];
  messages.forEach((message, index) => {
    if (message.role === "user" || !turns.length) turns.push([{ index, message }]);
    else turns[turns.length - 1].push({ index, message });
  });
  return turns.map((turn, turnIndex) => {
    const running = turn.some(({ message }) => message.role === "assistant" && isActiveStatus(messageRunStatus(message, message.run_id === latestSnapshot?.run_id ? latestSnapshot : null)));
    return (
      <section key={chatMessageKey(turn[0].message)} className="turn" data-last={turnIndex === turns.length - 1 ? "true" : undefined} data-status={running ? "running" : undefined}>
        {turn.map(({ index, message }) => (
          <HistoryMessage
            key={chatMessageKey(message)}
            message={message}
            snapshot={message.run_id === latestSnapshot?.run_id ? latestSnapshot : null}
            onRetry={index === lastRetry && message.run_id ? onRetry : undefined}
            onEdit={index === lastUser ? onEdit : undefined}
            processOpen={message.run_id ? processExpansion[message.run_id] : undefined}
            onProcessOpen={onProcessOpen}
          />
        ))}
      </section>
    );
  });
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
  useI18n();
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
  const currentMessage = snapshot ? messages.find((message) => message.role === "assistant" && message.run_id === snapshot.run_id) : undefined;
  const currentRunStatus = messageRunStatus(currentMessage, snapshot);
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
  }, [messages, snapshot?.items, snapshot?.status, scrollToLatest]);
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
    if (event.target instanceof Element && event.target.closest(".tb-out, .tb-code, .tb-plain, .tb-tree, .think-box, .steps.nested, .technical-details pre")) pauseForDetails();
    else userScrolling();
  }
  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    userScrollUntil.current = performance.now() + 400;
    if (event.target instanceof Element && event.target.closest(".proc-head, .st-head, .technical-details > summary, .tb-tech > summary, .tb-out, .tb-code, .tb-plain, .tb-tree, .think-box, .steps.nested, .technical-details pre"))
      pauseForDetails();
    else if (event.target === event.currentTarget) userScrolling();
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const navigationKey = ["Home", "End", "PageUp", "PageDown", "ArrowUp", "ArrowDown", " "].includes(event.key);
    const innerProcess = event.target instanceof Element && event.target.closest(".tb-out, .tb-code, .tb-plain, .tb-tree, .think-box, .steps.nested, .technical-details pre");
    if (innerProcess && navigationKey) {
      pauseForDetails();
      return;
    }
    const details = event.target instanceof Element && event.target.closest(".proc-head, .st-head, .technical-details > summary, .tb-tech > summary, .tb-out, .tb-code, .tb-plain, .tb-tree, .think-box, .steps.nested, .technical-details pre");
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
        className="scroller messages-scroll"
        role="region"
        aria-label={t("message.listLabel")}
        tabIndex={0}
        ref={scrollRef}
        onScroll={onScroll}
        onWheel={onUserScroll}
        onTouchMove={onUserScroll}
        onPointerDownCapture={onPointerDown}
        onKeyDownCapture={onKeyDown}
      >
        <div className="thread messages-column" ref={columnRef}>
          {onLoadOlder && (
            <button
              className="btn sm ghost older-messages"
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
              {olderLoading ? <LoadingDots label={t("status.loading")} /> : t("message.loadEarlier")}
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
          {snapshot?.waiting_input && currentRunStatus === "waiting_user" && (
            <WaitingInputCard
              key={`${snapshot.run_id}:${snapshot.waiting_input.kind ?? "question"}:${snapshot.waiting_input.question}`}
              waiting={snapshot.waiting_input}
              runId={snapshot.run_id}
              onResume={onResume}
            />
          )}
        </div>
      </div>
      {showJump && (
        <button className="icon-btn jump-latest" aria-label={t("message.latest")} onClick={jumpDown}>
          <ArrowDown className="ic" />
        </button>
      )}
    </div>
  );
}
