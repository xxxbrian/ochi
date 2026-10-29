import { errorForDisplay, type DisplayError } from "../lib/errors";
import { t, useI18n } from "../lib/i18n";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  Share,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import {
  ArrowDown,
  Check,
  Copy,
  Pencil,
  RotateCcw,
  Share2,
  ShieldCheck,
} from "lucide-react-native";
import { FlashList, type FlashListRef } from "@shopify/flash-list";
import * as Clipboard from "expo-clipboard";
import type { Message, Snapshot, WaitingInput } from "../lib/types";
import { isActiveStatus, userFacingRunError } from "../lib/api";
import { chatMessageKey, projectChatMessages, messagePresentation } from "../../../shared/conversation/projection";
import { useRunDetail } from "../hooks/useRunDetail";
import { useTheme } from "../providers/AppProvider";
import { LongPressMenu } from "../ui/LongPressMenu";
import {
  ActionIcon,
  AppText,
  Button,
  ErrorNotice,
} from "./ScreenChrome";
import { ArtifactCards } from "./Artifacts";
import { Activity } from "./Activity";
import { ArtifactMarkdown } from "./ArtifactMarkdown";
import { ProcessElapsed } from "./ProcessElapsed";

type Row = { key: string; message: Message; snapshot?: Snapshot };
type ProcessReadingChange = (runId: string, reading: boolean, interaction?: boolean) => void;

function projectRows(messages: Message[], run: Snapshot | null): Row[] {
  return projectChatMessages(messages, run).filter((message) => message.role !== 'system').map((message) => ({
    key: chatMessageKey(message), message,
    snapshot: message.role === 'assistant' && message.run_id === run?.run_id ? run ?? undefined : undefined,
  }));
}

type Props = {
  messages: Message[];
  run: Snapshot | null;
  hasOlder: boolean;
  loadingOlder: boolean;
  loadOlder: () => Promise<void>;
  refreshing: boolean;
  onRefresh: () => void;
  resume: (answer: string) => Promise<unknown>;
  onRetry: (message: Message) => Promise<void>;
  onEdit: (message: Message) => void;
  bottomInset?: number;
};

export const ChatMessages = memo(function ChatMessages({
  messages,
  run,
  hasOlder,
  loadingOlder,
  loadOlder,
  refreshing,
  onRefresh,
  resume,
  onRetry,
  onEdit,
  bottomInset = 16,
}: Props) {
  useI18n();
  const { colors } = useTheme();
  const list = useRef<FlashListRef<Row>>(null);
  const atBottom = useRef(true);
  const followTail = useRef(true);
  const interacting = useRef(false);
  const followFrame = useRef<number | null>(null);
  const answerFrame = useRef<number | null>(null);
  const processReaders = useRef(new Set<string>());
  const resumedReaders = useRef(new Set<string>());
  const initialTail = useRef(hasOlder || messages.length > 8);
  const [showJump, setShowJump] = useState(false);
  const [readingTranscript, setReadingTranscript] = useState(false);
  const [viewportHeight, setViewportHeight] = useState(0);
  const processHeight = viewportHeight > 0 ? Math.max(48, viewportHeight - bottomInset) : undefined;
  const rows = useMemo(() => projectRows(messages, run), [messages, run]);
  const scheduleFollow = useCallback(() => {
    if (followFrame.current !== null || !followTail.current || interacting.current || processReaders.current.size) return;
    followFrame.current = requestAnimationFrame(() => {
      followFrame.current = null;
      if (followTail.current && !interacting.current && !processReaders.current.size) list.current?.scrollToEnd({ animated: false });
    });
  }, []);
  useEffect(() => () => {
    if (followFrame.current !== null) cancelAnimationFrame(followFrame.current);
    if (answerFrame.current !== null) cancelAnimationFrame(answerFrame.current);
  }, []);
  const onProcessReadingChange = useCallback<ProcessReadingChange>((runId, reading, interaction) => {
    if (interaction) resumedReaders.current.delete(runId);
    if (reading && !resumedReaders.current.has(runId)) processReaders.current.add(runId);
    else processReaders.current.delete(runId);
    const paused = processReaders.current.size > 0;
    if (paused && followFrame.current !== null) {
      cancelAnimationFrame(followFrame.current);
      followFrame.current = null;
    }
    setShowJump(paused || !followTail.current);
  }, []);
  const active = isActiveStatus(run?.status);
  const lastUser = messages.findLast((message) => message.role === "user");
  const editableId =
    !active && lastUser && !lastUser.id.startsWith("pending-")
      ? lastUser.id
      : undefined;
  const lastAssistantIndex = rows.findLastIndex((row) => row.message.role === "assistant");
  const retryableKey = !active && lastAssistantIndex > rows.findLastIndex((row) => row.message.role === "user")
    ? rows[lastAssistantIndex]?.key : undefined;
  const more = () => {
    if (hasOlder && !loadingOlder) void loadOlder().catch(() => undefined);
  };
  function beginScroll() {
    interacting.current = true;
    followTail.current = false;
    if (followFrame.current !== null) cancelAnimationFrame(followFrame.current);
    followFrame.current = null;
    setReadingTranscript(true);
  }
  function endScroll() {
    interacting.current = false;
    followTail.current = atBottom.current;
    setReadingTranscript(!atBottom.current);
  }
  const jumpToLatest = useCallback(() => {
    for (const runId of processReaders.current) resumedReaders.current.add(runId);
    processReaders.current.clear();
    interacting.current = false;
    followTail.current = true;
    atBottom.current = true;
    setReadingTranscript(false);
    setShowJump(false);
    requestAnimationFrame(() => list.current?.scrollToEnd({ animated: true }));
  }, []);
  const viewAnswer = useCallback((key: string, offset: number) => {
    for (const runId of processReaders.current) resumedReaders.current.add(runId);
    processReaders.current.clear();
    interacting.current = false;
    followTail.current = false;
    if (followFrame.current !== null) cancelAnimationFrame(followFrame.current);
    followFrame.current = null;
    setReadingTranscript(false);
    setShowJump(false);
    if (answerFrame.current !== null) cancelAnimationFrame(answerFrame.current);
    answerFrame.current = requestAnimationFrame(() => {
      answerFrame.current = null;
      const index = rows.findIndex((row) => row.key === key);
      if (index >= 0) void list.current?.scrollToIndex({ index, viewPosition: 0, viewOffset: Math.max(0, offset - 4), animated: true });
    });
  }, [rows]);
  return (
    <View
      style={{ flex: 1 }}
      onLayout={(event) => {
        const height = Math.round(event.nativeEvent.layout.height);
        setViewportHeight((previous) => previous === height ? previous : height);
      }}
    >
      <FlashList
        ref={list}
        data={rows}
        keyExtractor={(item) => item.key}
        getItemType={(item) => item.message.role}
        maintainVisibleContentPosition={{
          startRenderingFromBottom: initialTail.current,
          // Library auto-tail queues cannot be cancelled by process interaction.
          // Keep its stable anchors, but own following through a guarded frame.
        }}
        onContentSizeChange={scheduleFollow}
        onScrollBeginDrag={beginScroll}
        onScrollEndDrag={endScroll}
        onMomentumScrollBegin={beginScroll}
        onMomentumScrollEnd={endScroll}
        onScroll={(event) => {
          const { contentOffset, contentSize, layoutMeasurement } =
            event.nativeEvent;
          const bottom =
            contentSize.height - contentOffset.y - layoutMeasurement.height <
            130;
          atBottom.current = bottom;
          if (interacting.current || bottom) followTail.current = bottom;
          const show = !followTail.current || processReaders.current.size > 0;
          setReadingTranscript((current) => current === !followTail.current ? current : !followTail.current);
          setShowJump((current) => current === show ? current : show);
        }}
        scrollEventThrottle={64}
        onStartReached={more}
        onStartReachedThreshold={0.15}
        refreshing={refreshing}
        onRefresh={onRefresh}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          ...styles.transcript,
          paddingBottom: bottomInset,
        }}
        ListHeaderComponent={
          hasOlder ? (
            <Pressable
              onPress={more}
              style={{ alignItems: "center", padding: 12 }}
            >
              {loadingOlder ? (
                <ActivityIndicator color={colors.muted} />
              ) : (
                <AppText muted size={12}>
                  {t("chat.earlierMessages")}</AppText>
              )}
            </Pressable>
          ) : null
        }
        renderItem={({ item }) =>
          item.message.role === "user" ? (
            <UserBubble
              key={item.key}
              message={item.message}
              onEdit={item.message.id === editableId ? onEdit : undefined}
            />
          ) : (
            <AssistantBubble
              key={item.key}
              message={item.message}
              snapshot={item.snapshot}
              onResume={resume}
              onRetry={item.key === retryableKey ? onRetry : undefined}
              processHeight={processHeight}
              onProcessReadingChange={onProcessReadingChange}
              readingTranscript={readingTranscript}
              onViewAnswer={(offset) => viewAnswer(item.key, offset)}
            />
          )
        }
      />
      {showJump && (viewportHeight === 0 || viewportHeight - bottomInset >= 44) && (
        <Pressable
          accessibilityLabel={t("chat.latestMessages")}
          onPress={jumpToLatest}
          style={[
            styles.jump,
            {
              bottom: bottomInset + 8,
              backgroundColor: colors.raised,
              borderColor: colors.border,
            },
          ]}
        >
          <ArrowDown size={18} color={colors.text} />
        </Pressable>
      )}
    </View>
  );
});

const UserBubble = memo(function UserBubble({
  message,
  onEdit,
}: {
  message: Message;
  onEdit?: Props["onEdit"];
}) {
  useI18n();
  const { colors } = useTheme();
  return (
      <View style={styles.userRow}>
        <View
          style={{
            maxWidth: "88%",
            width: message.attachments?.length ? "88%" : undefined,
            alignItems: "flex-end",
          }}
        >
          <ArtifactCards files={message.attachments} />
          <LongPressMenu label={message.content} items={[
            { key: "copy", title: t("common.copy"), icon: Copy, onPress: () => void Clipboard.setStringAsync(message.content) },
            ...(onEdit ? [{ key: "edit", title: t("chat.editMessage"), icon: Pencil, onPress: () => onEdit(message) }] : []),
          ]}>
            <View style={[styles.userBubble, { backgroundColor: colors.hover }]}>
              <AppText size={16}>{message.content}</AppText>
            </View>
          </LongPressMenu>
        </View>
      </View>
    );
});

const AssistantBubble = memo(function AssistantBubble({
  message,
  snapshot,
  onResume,
  onRetry,
  processHeight,
  onProcessReadingChange,
  readingTranscript = false,
  onViewAnswer,
}: {
  message: Message;
  snapshot?: Snapshot;
  onResume: Props["resume"];
  onRetry?: Props["onRetry"];
  processHeight?: number;
  onProcessReadingChange: ProcessReadingChange;
  readingTranscript?: boolean;
  onViewAnswer?: (offset: number) => void;
}) {
  useI18n();
  const { colors } = useTheme();
  const [error, setError] = useState<DisplayError>("");
  const [copied, setCopied] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const reading = useRef(false);
  const runId = message.run_id;
  const provided = snapshot?.run_id === runId ? snapshot : null;
  const detail = useRunDetail(runId ?? "", provided ?? null, message.run_status, historyOpen);
  const saved = detail.snapshot;
  const historyLoading = detail.loading;
  const presentation = messagePresentation(message, saved);
  const { needsTerminal, snapshot: current, fallback: bodyFallback, copyText: content } = presentation;
  const status = current?.status ?? message.run_status;
  const active = isActiveStatus(status);
  const display = current;
  const files = current?.artifacts ?? message.attachments;
  const process = Boolean(current || message.has_process || message.step_count || message.has_reasoning ||
    status === "failed" || status === "interrupted" || status === "cancelled");
  const readingChange = useCallback((isReading: boolean, interaction?: boolean) => {
    if (reading.current === isReading && !interaction) return;
    reading.current = isReading;
    if (runId) {
      if (interaction) onProcessReadingChange(runId, isReading, true);
      else onProcessReadingChange(runId, isReading);
    }
  }, [runId, onProcessReadingChange]);
  useEffect(() => () => {
    if (reading.current) readingChange(false);
  }, [readingChange]);
  function loadHistory() {
    setHistoryOpen(true);
    detail.retry();
  }
  async function copy() {
    await Clipboard.setStringAsync(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  function retry() {
    if (!onRetry) return;
    void onRetry({ ...message, content }).catch((reason) => setError(errorForDisplay(reason, "error.retry")));
  }
  return (
    <View style={styles.assistant}>
      {process && (display ? (
        <Activity snapshot={display} defaultExpanded={historyOpen} availableHeight={processHeight} onReadingChange={readingChange}
          readingTranscript={readingTranscript} onViewAnswer={onViewAnswer} />
      ) : (
        <View>
          <Pressable onPress={() => void loadHistory()} style={{ minHeight: 34, flexDirection: "row", alignItems: "center", gap: 7, marginBottom: 8 }}>
            <AppText muted size={13}>{message.run_status === "completed" ? t("status.completed") : message.run_status === "cancelled" ? t("status.stopped") : message.run_status === "failed" || message.run_status === "interrupted" ? t("status.incomplete") : t("process.history")}{message.step_count ? ` ${t("process.steps", { count: message.step_count })}` : ""}</AppText>
            <ProcessElapsed createdAt={message.run_created_at} updatedAt={message.run_updated_at} active={active} />
          </Pressable>
          {historyLoading && <ActivityIndicator color={colors.muted} />}
        </View>
      ))}
      {needsTerminal && (detail.loading || detail.failed) && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <AppText muted size={12}>{detail.loading ? t("process.syncing") : t("error.processSync")}</AppText>
          {!detail.loading && <Pressable accessibilityRole="button" accessibilityLabel={t("process.retrySync")} onPress={detail.retry} style={{ minHeight: 32, justifyContent: "center" }}>
            <AppText size={12}>{t("common.retry")}</AppText>
          </Pressable>}
        </View>
      )}
      {bodyFallback ? (
        <ArtifactMarkdown
          content={bodyFallback}
          files={files}
          streaming={active}
        />
      ) : null}
      <ArtifactCards files={files} />
      {provided?.waiting_input && status === "waiting_user" && (
        <WaitingCard waiting={provided.waiting_input} onResume={onResume} />
      )}
      {!active && content ? (
        <View style={styles.actions}>
          <ActionIcon
            icon={copied ? Check : Copy}
            label={t("chat.copyReply")}
            size={17}
            style={styles.messageAction}
            onPress={() => void copy()}
          />
          <ActionIcon
            icon={Share2}
            label={t("chat.shareReply")}
            size={17}
            style={styles.messageAction}
            onPress={() => void Share.share({ message: content })}
          />
          {onRetry && <ActionIcon
            icon={RotateCcw}
            label={t("chat.regenerate")}
            size={17}
            style={styles.messageAction}
            onPress={retry}
          />}
        </View>
      ) : null}
      {(status === "failed" || status === "interrupted") && (
        <View style={styles.failure}>
          <AppText size={14} style={{ color: colors.error }}>
            {files?.length
              ? t("error.runFilesAvailable")
              : content.trim() ? t("error.replyPartial") : t("error.replyFailed")}
          </AppText>
          {onRetry && <Pressable onPress={retry}>
            <AppText size={14} weight="medium">
              {t("common.retry")}</AppText>
          </Pressable>}
        </View>
      )}
      {!current && <ErrorNotice error={message.run_error ? userFacingRunError(message.run_error, Boolean(files?.length), message.run_error_code) : undefined} />}
      <ErrorNotice error={error} />
    </View>
  );
});

export function WaitingCard({
  waiting,
  onResume,
}: {
  waiting: WaitingInput;
  onResume: (answer: string) => Promise<unknown>;
}) {
  useI18n();
  const { colors, fonts } = useTheme();
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DisplayError>("");
  async function resume(value: string) {
    if (!value.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await onResume(value);
    } catch (reason) {
      setError(errorForDisplay(reason, "error.send"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View
      style={[
        styles.waiting,
        { backgroundColor: colors.surface, borderColor: colors.border },
      ]}
    >
      {waiting.kind === "computer_permission" && (
        <View style={styles.waitingHeading}>
          <ShieldCheck size={19} color={colors.text} />
          <AppText weight="medium">{t("permission.useComputer")}</AppText>
        </View>
      )}
      <AppText size={15}>{waiting.question}</AppText>
      {waiting.kind === "computer_permission" ? (
        <View style={styles.permissionActions}>
          <Button busy={busy} onPress={() => void resume("allow_once")}>
            {t("permission.once")}</Button>
          <Button
            secondary
            disabled={busy}
            onPress={() => void resume("allow_session")}
          >
            {t("permission.session")}</Button>
          <Pressable
            disabled={busy}
            onPress={() => void resume("deny")}
            style={{ padding: 10 }}
          >
            <AppText muted size={14}>
              {t("permission.deny")}</AppText>
          </Pressable>
        </View>
      ) : (
        <>
          {waiting.options?.length ? (
            <View style={styles.permissionActions}>
              {waiting.options.map((option) => (
                <Button
                  key={option}
                  secondary={answer !== option}
                  disabled={busy}
                  onPress={() => setAnswer(option)}
                >
                  {option}
                </Button>
              ))}
            </View>
          ) : null}
          <View style={styles.answer}>
            <TextInput
              value={answer}
              onChangeText={setAnswer}
              placeholder={t("chat.enterReply")}
              placeholderTextColor={colors.subtle}
              style={{
                flex: 1,
                padding: 10,
                color: colors.text,
                fontSize: 15,
                fontFamily: fonts.regular,
              }}
            />
            <Button
              disabled={!answer.trim()}
              busy={busy}
              onPress={() => void resume(answer)}
            >
              {t("common.continue")}</Button>
          </View>
        </>
      )}
      <ErrorNotice error={error} />
    </View>
  );
}

const styles = StyleSheet.create({
  transcript: { paddingHorizontal: 18, paddingTop: 14, paddingBottom: 16 },
  userRow: {
    alignItems: "flex-end",
    marginTop: 14,
    marginBottom: 18,
    width: "100%",
    maxWidth: 780,
    alignSelf: "center",
  },
  userBubble: {
    borderRadius: 21,
    borderBottomRightRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  assistant: {
    paddingBottom: 22,
    paddingTop: 4,
    width: "100%",
    maxWidth: 780,
    alignSelf: "center",
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 1,
    marginLeft: -6,
    marginTop: 1,
  },
  messageAction: { width: 36, height: 32 },
  jump: {
    position: "absolute",
    bottom: 12,
    right: 20,
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  waiting: {
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 14,
    gap: 11,
    marginTop: 10,
  },
  waitingHeading: { flexDirection: "row", alignItems: "center", gap: 9 },
  permissionActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 7,
  },
  answer: { flexDirection: "row", gap: 8, alignItems: "center" },
  failure: { flexDirection: "row", gap: 12, marginTop: 8 },
});
