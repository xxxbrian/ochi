import { projectRun } from "../../../shared/conversation/projection";
import { t, useI18n, type MessageKey } from "../lib/i18n";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  LayoutAnimation,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type NativeScrollEvent,
  useWindowDimensions,
} from "react-native";
import {
  ArrowDown,
  Check,
  CircleAlert,
  FileText,
  Globe,
  Monitor,
  Square,
  Terminal,
  Wrench,
  type LucideIcon,
} from "lucide-react-native";
import type { Artifact, ProcessEntry, Snapshot } from "../lib/types";
import { isActiveStatus, userFacingRunError } from "../lib/api";
import {
  detailLabel,
  formatReasoningText,
  timelineSegments,
  processNearBottom,
  processPanelLimit,
  processRows,
  stepTarget,
  type ProcessRow,
  type ToolFamily,
} from "../lib/processTimeline";
import { useTheme } from "../providers/AppProvider";
import { AppText } from "./ScreenChrome";
import { Markdown } from "./Markdown";
import { StepRow, type StepExpansion } from "./ActivityStep";
import { ProcessElapsed } from "./ProcessElapsed";
import { ArtifactMarkdown } from "./ArtifactMarkdown";
import { ActivityDisclosure, ActivityStatusText, OchiActivityMark, useReducedMotion } from "./OchiActivityMark";

export { StepRow } from "./ActivityStep";

export function runLabel(snapshot: Snapshot) {
  if (snapshot.status === "completed") return t("status.completed");
  if (snapshot.status === "cancelled") return t("status.stopped");
  if (snapshot.status === "failed" || snapshot.status === "interrupted") return t("status.incomplete");
  if (snapshot.status === "cancelling") return t("status.stopping");
  if (snapshot.status === "queued") return t("status.queued");
  if (snapshot.status === "waiting_user")
    return snapshot.waiting_input?.kind === "computer_permission" ? t("status.waitingPermission") : t("status.waitingReply");
  if (snapshot.status === "waiting_resource")
    return snapshot.resource?.includes("desktop") ? t("status.waitingComputer") : t("status.waitingWorkspace");
  const view = projectRun(snapshot);
  const running = view.steps.findLast((step) => step.status === "running");
  if (running) {
    if (/image/.test(running.name)) return t("status.generatingImage");
    if (/^(?:web_search|search)$/.test(running.name)) return t("status.searching");
    if (/^(?:web_fetch|fetch)$/.test(running.name)) return t("status.reading");
    if (running.name === "exec") return t("status.runningCode");
    if (running.name.startsWith("browser_")) return t("status.browsing");
    if (running.name.startsWith("computer_")) return t("status.usingComputer");
    if (running.name.startsWith("files_")) return t("status.handlingFiles");
    return t("status.working");
  }
  const latest = view.entries.at(-1);
  if (latest?.kind === "progress" && latest.text) return t("status.replying");
  if (view.reasoning.some((part) => !part.done)) return t("status.thinking");
  return t("status.working");
}

type ReadingChange = (reading: boolean, interaction?: boolean) => void;

export const Activity = memo(function Activity({
  snapshot,
  defaultExpanded = false,
  availableHeight,
  onReadingChange,
  readingTranscript = false,
  onViewAnswer,
}: {
  snapshot: Snapshot;
  defaultExpanded?: boolean;
  availableHeight?: number;
  onReadingChange?: ReadingChange;
  readingTranscript?: boolean;
  onViewAnswer?: (offset: number) => void;
}) {
  useI18n();
  const { colors } = useTheme();
  const reducedMotion = useReducedMotion();
  const view = useMemo(() => projectRun(snapshot), [snapshot]);
  const completed = snapshot.status === "completed";
  const active = isActiveStatus(snapshot.status);
  const working = snapshot.status === "running";
  const [open, setOpen] = useState(defaultExpanded);
  const [openGroup, setOpenGroup] = useState<string | null>(() => defaultExpanded
    ? view.plan.rows.find((row) => row.kind === "process")?.id ?? null : null);
  const [manualReading, setManualReading] = useState(defaultExpanded);
  const [heldAtCompletion, setHeldAtCompletion] = useState(false);
  const [finishedLayout, setFinishedLayout] = useState(completed);
  const wasCompleted = useRef(completed);
  const answerOffset = useRef(0);
  const answerRequested = useRef(false);
  const [stepExpansion, setStepExpansion] = useState<Record<string, StepExpansion>>({});
  const changeStepExpansion = useCallback((id: string, next: StepExpansion) => {
    setStepExpansion((previous) => previous[id]?.open === next.open && previous[id]?.technical === next.technical
      ? previous : { ...previous, [id]: next });
  }, []);
  const timeline = view.entries;
  const segments = useMemo(() => timelineSegments(timeline), [timeline]);
  const history = useMemo(() => timeline.filter((entry) => !entry.final), [timeline]);
  const hasHistory = view.plan.hasWork;
  const firstFinal = timeline.find((entry) => entry.kind === "progress" && entry.final && entry.text?.trim())?.id;
  const canFold = view.plan.canRollUp;
  // Lock in an explicit reading choice before removing earlier native views.
  const retainHistory = heldAtCompletion || (completed && !wasCompleted.current && (manualReading || readingTranscript));
  useEffect(() => {
    if (completed && !wasCompleted.current) {
      setHeldAtCompletion(manualReading || readingTranscript);
      if (!manualReading && !readingTranscript && !reducedMotion) LayoutAnimation.configureNext({
        duration: 220, update: { type: "easeInEaseOut" }, delete: { type: "easeInEaseOut", property: "opacity" },
      });
      setFinishedLayout(true);
    }
    wasCompleted.current = completed;
  }, [completed, manualReading, readingTranscript, reducedMotion]);
  const onDetailReading = useCallback<ReadingChange>((reading, interaction) => {
    if (interaction) setManualReading(true);
    onReadingChange?.(reading, interaction);
  }, [onReadingChange]);
  const collapse = canFold && finishedLayout && hasHistory && !retainHistory;
  const completedSteps = view.steps.filter((step) => step.status === "completed" && step.outcome !== "needs_user").length;
  function toggleHistory() {
    const next = !open;
    setOpen(next);
    setManualReading(next);
    onReadingChange?.(next, next);
  }
  function viewAnswer() {
    if (!reducedMotion) LayoutAnimation.configureNext({ duration: 220, update: { type: "easeInEaseOut" } });
    setHeldAtCompletion(false);
    setManualReading(false);
    setOpen(false);
    setOpenGroup(null);
    onReadingChange?.(false);
    answerRequested.current = true;
    onViewAnswer?.(answerOffset.current);
  }
  return (
    <View style={styles.activity}>
      {(active || hasHistory || snapshot.error || !completed) && <View style={styles.headerRow}>
        <Pressable
          disabled={!hasHistory || !canFold || retainHistory}
          onPress={toggleHistory}
          accessibilityRole={hasHistory && canFold ? "button" : undefined}
          accessibilityState={hasHistory && canFold ? { expanded: open || retainHistory } : undefined}
          accessibilityLabel={runLabel(snapshot)}
          style={styles.activityHeader}
        >
          {active ? <OchiActivityMark working={working} /> : completed
            ? <Check size={16} color={colors.muted} /> : snapshot.status === "cancelled"
              ? <Square size={14} color={colors.muted} /> : <CircleAlert size={16} color={colors.error} />}
          <ActivityStatusText working={working}>{runLabel(snapshot)}</ActivityStatusText>
          {view.steps.length > 0 && <AppText muted size={12}>{completed ? t("process.steps", { count: view.steps.length }) : `· ${t("process.completedSteps", { count: completedSteps })}`}</AppText>}
          <ProcessElapsed createdAt={snapshot.created_at} updatedAt={snapshot.updated_at} active={active} />
          {hasHistory && canFold && !retainHistory && <ActivityDisclosure color={colors.subtle} open={open} />}
        </Pressable>
        {canFold && retainHistory && <Pressable accessibilityRole="button" accessibilityLabel={t("process.viewAnswer")} onPress={viewAnswer} style={styles.answerLink}>
          <AppText muted size={12}>{t("process.viewAnswer")}</AppText><ArrowDown size={12} color={colors.muted} />
        </Pressable>}
      </View>}
      {collapse && open && <ProcessViewport maxHeight={processPanelLimit(availableHeight)} onReadingChange={onDetailReading}>
        {processRows(history).map((row) => <ProcessRowView key={row.id} row={row} active={false} stepExpansion={stepExpansion} onStepExpansionChange={changeStepExpansion} />)}
      </ProcessViewport>}
      {segments.map((segment) => segment.kind === "text" ? (
        <PublicText key={segment.id} entry={segment.entry} hidden={collapse && !segment.entry.final}
          active={working && segment.id === timeline.at(-1)?.id} files={snapshot.artifacts} onReadingChange={onDetailReading}
          onLayout={segment.id === firstFinal ? (offset) => {
            answerOffset.current = offset;
            if (answerRequested.current) { answerRequested.current = false; onViewAnswer?.(offset); }
          } : undefined} />
      ) : (
        <DetailSection key={segment.id} id={segment.id} entries={segment.entries} hidden={collapse}
          open={openGroup === segment.id} active={working} availableHeight={availableHeight}
          onToggle={() => {
            const next = openGroup !== segment.id;
            setOpenGroup(next ? segment.id : null);
            setManualReading(next);
            onReadingChange?.(next, next);
          }} onReadingChange={onDetailReading} stepExpansion={stepExpansion} onStepExpansionChange={changeStepExpansion} />
      ))}
      {snapshot.error && <AppText size={13} style={{ color: colors.error, paddingVertical: 6 }}>{userFacingRunError(snapshot.error, Boolean(snapshot.artifacts?.length), snapshot.error_code)}</AppText>}
    </View>
  );
});

const PublicText = memo(function PublicText({ entry, hidden, active, files, onReadingChange, onLayout }: {
  entry: ProcessEntry; hidden: boolean; active: boolean; files?: Artifact[]; onReadingChange?: ReadingChange; onLayout?: (offset: number) => void;
}) {
  useI18n();
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (hold.current !== null) clearTimeout(hold.current); }, []);
  return (
    <View collapsable={false} style={[styles.publicText, hidden && styles.hidden]} onLayout={onLayout ? (event) => onLayout(event.nativeEvent.layout.y) : undefined}
      onTouchStart={() => {
        if (hold.current !== null) clearTimeout(hold.current);
        hold.current = setTimeout(() => { hold.current = null; onReadingChange?.(true, true); }, 350);
      }}
      onTouchEnd={() => { if (hold.current !== null) clearTimeout(hold.current); hold.current = null; }}
      onTouchCancel={() => { if (hold.current !== null) clearTimeout(hold.current); hold.current = null; }}>
      <ArtifactMarkdown content={entry.text ?? ""} files={files} streaming={active} />
    </View>
  );
});

const DetailSection = memo(function DetailSection({ id, entries, hidden, open, active, availableHeight, onToggle, onReadingChange, ...expansion }: {
  id: string; entries: ProcessEntry[]; hidden: boolean; open: boolean; active: boolean;
  availableHeight?: number; onToggle: () => void; onReadingChange?: ReadingChange;
} & ToolExpansionProps) {
  useI18n();
  const { colors } = useTheme();
  const rows = useMemo(() => processRows(entries), [entries]);
  if (!entries.some((entry) => entry.step || entry.reasoning?.text.trim())) return null;
  return <View collapsable={false} style={[styles.details, hidden && styles.hidden]}>
    <Pressable accessibilityRole="button" accessibilityLabel={detailLabel(entries)} accessibilityState={{ expanded: open }} onPress={onToggle} style={styles.detailHeader}>
      <ActivityDisclosure color={colors.subtle} open={open} />
      <AppText muted size={13} numberOfLines={1} style={{ flexShrink: 1 }}>{detailLabel(entries)}</AppText>
    </Pressable>
    {open && !hidden && <ProcessViewport key={id} maxHeight={processPanelLimit(availableHeight)} onReadingChange={onReadingChange}>
      {rows.map((row) => <ProcessRowView key={row.id} row={row} active={active} {...expansion} />)}
    </ProcessViewport>}
  </View>;
});

const ProcessText = memo(function ProcessText({ entry, active }: { entry: ProcessEntry; active: boolean }) {
  useI18n();
  const { colors } = useTheme();
  const { fontScale } = useWindowDimensions();
  const reasoning = entry.kind === "reasoning" ? entry.reasoning : undefined;
  const content = reasoning ? formatReasoningText(reasoning.text) : entry.text ?? "";
  const [expanded, setExpanded] = useState(false);
  const [height, setHeight] = useState(0);
  const limit = Math.ceil(22 * Math.max(1, fontScale) * 4);
  if (!content.trim()) return null;
  const canExpand = Boolean(reasoning && height > limit + 1);
  return (
    <View collapsable={false} style={[styles.processText, { borderLeftColor: colors.border }]}>
      <View style={styles.textHeading}>
        <AppText muted size={11}>{entry.kind === "progress" ? t("process.progress") : reasoning?.kind === "summary" ? t("process.reasoningSummary") : t("process.reasoning")}</AppText>
      </View>
      <View style={reasoning ? { height: expanded ? height || limit : Math.min(height || limit, limit), overflow: "hidden" } : undefined}>
        <View collapsable={false} style={reasoning ? styles.reasoningContent : undefined}
          onLayout={(event) => {
            const measuredHeight = event.nativeEvent.layout.height;
            setHeight((previous) => Math.abs(previous - measuredHeight) < 1 ? previous : measuredHeight);
          }}>
          <Markdown compact content={content} streaming={active && Boolean(entry.pending || (reasoning && !reasoning.done))} />
        </View>
      </View>
      {canExpand && <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded(!expanded)} style={styles.reasoningToggle}>
        <AppText muted size={12}>{expanded ? t("process.hideReasoning") : t("process.showReasoning")}</AppText>
        <ActivityDisclosure size={12} color={colors.muted} open={expanded} />
      </Pressable>}
    </View>
  );
});

const familyInfo: Record<ToolFamily, [MessageKey, LucideIcon]> = {
  commands: ["process.runCommands", Terminal],
  files: ["process.handleFiles", FileText],
  browser: ["process.browse", Globe],
  computer: ["process.useComputer", Monitor],
  integration: ["process.callTools", Wrench],
};

type ToolExpansionProps = {
  stepExpansion: Record<string, StepExpansion>;
  onStepExpansionChange: (id: string, expansion: StepExpansion) => void;
};
const collapsedStep: StepExpansion = { open: false, technical: false };

const ProcessRowView = memo(function ProcessRowView({ row, active, ...expansion }: { row: ProcessRow; active: boolean } & ToolExpansionProps) {
  if (row.kind === "entry") return <ProcessText entry={row.entry} active={active} />;
  return <ToolGroup row={row} {...expansion} />;
});

const ToolGroup = memo(function ToolGroup({ row, stepExpansion, onStepExpansionChange }: { row: Extract<ProcessRow, { kind: "tools" }> } & ToolExpansionProps) {
  useI18n();
  const { colors } = useTheme();
  const [chosenOpen, setOpen] = useState<boolean | undefined>();
  // A new adjacent tool must not fold the detail the user was already reading.
  const open = chosenOpen ?? row.steps.some((step) => stepExpansion[step.id]?.open);
  const stepRows = row.steps.map((step) => <StepRow key={step.id} step={step} expansion={stepExpansion[step.id] ?? collapsedStep} onExpansionChange={onStepExpansionChange} />);
  if (row.steps.length === 1 || !row.family) return <View collapsable={false} style={styles.group}>{stepRows}</View>;
  const [labelKey, Icon] = familyInfo[row.family];
  const label = t(labelKey);
  const completed = row.steps.filter((step) => step.status === "completed" && step.outcome !== "needs_user").length;
  const running = row.steps.findLast((step) => step.status === "running");
  return (
    <View collapsable={false} style={styles.group}>
      <Pressable
        onPress={() => setOpen(!open)}
        accessibilityRole="button"
        accessibilityLabel={t("process.actionCount", { label, count: row.steps.length })}
        accessibilityState={{ expanded: open }}
        style={styles.groupHeader}
      >
        <View style={styles.groupIcon}>{running ? <ActivityIndicator size="small" color={colors.muted} /> : <Icon size={15} color={colors.muted} strokeWidth={1.7} />}</View>
        <View style={{ flex: 1 }}>
          <AppText size={13}>{row.family === "commands" ? t("process.commandCount", { count: row.steps.length }) : t("process.actionCount", { label, count: row.steps.length })}</AppText>
          <AppText muted size={11} numberOfLines={1}>{running ? stepTarget(running) || t("status.working") : t("process.completedActions", { count: completed })}</AppText>
        </View>
        <ActivityDisclosure color={colors.subtle} open={Boolean(open)} />
      </Pressable>
      {open && <View style={[styles.groupBody, { borderLeftColor: colors.border }]}>{stepRows}</View>}
    </View>
  );
});

function ProcessViewport({ maxHeight, children, onReadingChange }: { maxHeight: number; children: ReactNode; onReadingChange?: (reading: boolean, interaction?: boolean) => void }) {
  useI18n();
  const { colors } = useTheme();
  const scroll = useRef<ScrollView>(null);
  const follow = useRef(true);
  const interacting = useRef(false);
  const frame = useRef<number | null>(null);
  const settleFrame = useRef<number | null>(null);
  const metrics = useRef({ content: 0, viewport: 0, offset: 0 });
  const reading = useRef(true);
  const readingCallback = useRef(onReadingChange);
  readingCallback.current = onReadingChange;
  const [showTail, setShowTail] = useState(false);
  function notifyReading(next: boolean, interaction = false) {
    if (reading.current === next && !interaction) return;
    reading.current = next;
    readingCallback.current?.(next, interaction);
  }
  useEffect(() => {
    readingCallback.current?.(true);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      if (settleFrame.current !== null) cancelAnimationFrame(settleFrame.current);
      readingCallback.current?.(false);
    };
  }, []);
  const scheduleFollow = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (follow.current && !interacting.current) {
        scroll.current?.scrollToEnd({ animated: false });
        if (processNearBottom(metrics.current.offset, metrics.current.content, metrics.current.viewport)) notifyReading(false);
      }
    });
  };
  const updatePosition = (event: NativeScrollEvent) => {
    metrics.current = { offset: event.contentOffset.y, content: event.contentSize.height, viewport: event.layoutMeasurement.height };
    const bottom = processNearBottom(metrics.current.offset, metrics.current.content, metrics.current.viewport);
    if (frame.current !== null && follow.current && !interacting.current) return;
    follow.current = bottom;
    notifyReading(interacting.current || !bottom);
    setShowTail((previous) => previous === !bottom ? previous : !bottom);
  };
  const beginInteraction = () => {
    if (settleFrame.current !== null) cancelAnimationFrame(settleFrame.current);
    settleFrame.current = null;
    interacting.current = true;
    follow.current = false;
    notifyReading(true, true);
  };
  const endInteraction = () => {
    interacting.current = false;
    // A tap can expand a tool before native layout reports its new content size.
    if (settleFrame.current !== null) cancelAnimationFrame(settleFrame.current);
    settleFrame.current = requestAnimationFrame(() => {
      settleFrame.current = requestAnimationFrame(() => {
        settleFrame.current = null;
        if (interacting.current) return;
        const bottom = processNearBottom(metrics.current.offset, metrics.current.content, metrics.current.viewport);
        follow.current = bottom;
        notifyReading(!bottom);
        setShowTail(!bottom);
      });
    });
  };
  return (
    <View style={[styles.viewport, { maxHeight, borderColor: colors.border }]}>
      <ScrollView
        ref={scroll}
        style={{ maxHeight, flexGrow: 0 }}
        contentContainerStyle={styles.activityBody}
        nestedScrollEnabled
        directionalLockEnabled
        keyboardShouldPersistTaps="always"
        keyboardDismissMode="none"
        showsVerticalScrollIndicator
        scrollEventThrottle={32}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        onTouchStart={beginInteraction}
        onTouchEnd={endInteraction}
        onTouchCancel={endInteraction}
        onScrollBeginDrag={beginInteraction}
        onScrollEndDrag={(event) => { interacting.current = false; updatePosition(event.nativeEvent); }}
        onMomentumScrollBegin={beginInteraction}
        onMomentumScrollEnd={(event) => { interacting.current = false; updatePosition(event.nativeEvent); }}
        onScroll={(event) => updatePosition(event.nativeEvent)}
        onLayout={(event) => { metrics.current.viewport = event.nativeEvent.layout.height; scheduleFollow(); }}
        onContentSizeChange={(_width, height) => {
          metrics.current.content = height;
          if (follow.current && !interacting.current) scheduleFollow();
          else {
            const bottom = processNearBottom(metrics.current.offset, height, metrics.current.viewport);
            notifyReading(interacting.current || !bottom);
            setShowTail(!bottom);
          }
        }}
      >
        {children}
      </ScrollView>
      {showTail && <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("process.latestProgress")}
        onPress={() => {
          follow.current = true;
          interacting.current = false;
          notifyReading(false);
          setShowTail(false);
          scroll.current?.scrollToEnd({ animated: false });
        }}
        style={[styles.tail, { backgroundColor: colors.raised, borderColor: colors.border }]}
      ><ArrowDown size={13} color={colors.text} /></Pressable>}
    </View>
  );
}

const styles = StyleSheet.create({
  activity: { marginBottom: 10 },
  activityHeader: { flexDirection: "row", gap: 7, alignItems: "center", minHeight: 34, flexShrink: 1, flexWrap: "wrap" },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  answerLink: { minHeight: 36, flexDirection: "row", alignItems: "center", gap: 4 },
  publicText: { paddingTop: 4 },
  hidden: { display: "none" },
  details: { marginBottom: 7 },
  detailHeader: { minHeight: 36, flexDirection: "row", alignItems: "center", gap: 6 },
  reasoningToggle: { minHeight: 32, flexDirection: "row", alignItems: "center", gap: 4 },
  // The intrinsic native Markdown height must not inherit the preview's cap.
  reasoningContent: { position: "absolute", top: 0, left: 0, right: 0 },
  viewport: { marginTop: 3, borderTopWidth: StyleSheet.hairlineWidth },
  activityBody: { paddingVertical: 6, paddingRight: 6, gap: 4 },
  processText: { borderLeftWidth: 1, paddingLeft: 10, paddingVertical: 2 },
  textHeading: { flexDirection: "row", alignItems: "center", gap: 5, marginBottom: 3 },
  group: { paddingVertical: 1 },
  groupHeader: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 },
  groupIcon: { width: 18, alignItems: "center" },
  groupBody: { borderLeftWidth: 1, paddingLeft: 9, marginLeft: 8, paddingVertical: 2 },
  tail: { position: "absolute", bottom: 7, right: 8, width: 30, height: 30, borderRadius: 15, borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center" },
});
