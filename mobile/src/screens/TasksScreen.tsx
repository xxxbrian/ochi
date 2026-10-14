import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  View,
  type NativeScrollEvent,
} from "react-native";
import {
  ArrowUpRight,
  CalendarClock,
  ChevronRight,
  Clock3,
  Pencil,
  Play,
  Plus,
  Square,
  Trash2,
} from "lucide-react-native";
import { router } from "expo-router";
import { api, isActiveStatus } from "../lib/api";
import { unrepresentedOutput } from "../lib/processTimeline";
import type { Schedule, ScheduleExecution, Snapshot } from "../lib/types";
import { useApp } from "../providers/AppProvider";
import { useRunStream } from "../hooks/useRunStream";
import {
  ActionIcon,
  AppText,
  Button,
  EmptyState,
  ErrorNotice,
  LoadingState,
  PageHeader,
  SectionTitle,
  screenStyles,
  usePageContentStyle,
} from "../components/ScreenChrome";
import { TaskEditor } from "../components/TaskEditor";
import { Activity, runLabel } from "../components/Activity";
import { ArtifactCards } from "../components/Artifacts";
import { WaitingCard } from "../components/ChatMessages";
import { ArtifactMarkdown } from "../components/ArtifactMarkdown";

const weekdays = ["一", "二", "三", "四", "五", "六", "日"];
function timing(task: Schedule) {
  if (task.recurrence === "once")
    return task.once_at ? taskDate(task.once_at, task.timezone) : "单次";
  if (task.recurrence === "daily") return `每天 ${task.time_of_day ?? "09:00"}`;
  if (task.recurrence === "weekly")
    return `周 ${(task.weekdays ?? []).map((day) => weekdays[day - 1]).join("、")} ${task.time_of_day ?? "09:00"}`;
  return `每 ${task.interval_minutes} 分钟`;
}
function taskDate(value?: string, timezone?: string) {
  if (!value) return "";
  const date = new Date(value);
  const year = new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    year: "numeric",
  });
  return date.toLocaleString("zh-CN", {
    timeZone: timezone,
    year: year.format(date) !== year.format(new Date()) ? "numeric" : undefined,
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
function statusText(status?: string) {
  return (
    (
      {
        completed: "已完成",
        failed: "失败",
        running: "进行中",
        queued: "排队中",
        skipped: "已跳过",
        cancelled: "已停止",
        interrupted: "已中断",
      } as Record<string, string>
    )[status ?? ""] ?? "未执行"
  );
}

export function TasksScreen() {
  const { colors, invalidateVersion, invalidateLists } = useApp();
  const contentStyle = usePageContentStyle({ horizontal: 18, top: 0, bottom: 30, gap: 0 });
  const [items, setItems] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "enabled" | "disabled">("all");
  const [editing, setEditing] = useState<Schedule | "new" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const refresh = useCallback(() => {
    setLoading(true);
    void api
      .schedules()
      .then(setItems)
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : "加载失败"),
      )
      .finally(() => setLoading(false));
  }, []);
  useEffect(refresh, [refresh, invalidateVersion]);
  async function toggle(task: Schedule, enabled: boolean) {
    setBusy(task.id);
    try {
      const value = await api.saveSchedule({ id: task.id, enabled });
      setItems((current) =>
        current.map((item) => (item.id === value.id ? value : item)),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败");
    } finally {
      setBusy(null);
    }
  }
  async function run(task: Schedule) {
    setBusy(task.id);
    try {
      const snapshot = await api.runSchedule(task.id);
      invalidateLists();
      const executions = await api.scheduleExecutions(task.id);
      const record = executions.find((item) => item.run_id === snapshot.run_id);
      router.push(
        record ? `/tasks/${task.id}/runs/${record.id}` : `/tasks/${task.id}`,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "执行失败");
    } finally {
      setBusy(null);
    }
  }
  const visible = items.filter(
    (item) => filter === "all" || (filter === "enabled") === item.enabled,
  );
  return (
    <View style={[screenStyles.fill, { backgroundColor: colors.canvas }]}>
      <PageHeader
        title="定时任务"
        right={
          <ActionIcon
            icon={Plus}
            label="创建任务"
            onPress={() => setEditing("new")}
          />
        }
      />
      <View style={[styles.filters, contentStyle, { paddingTop: 4, paddingBottom: 4, gap: 5 }]}>
        {(
          [
            { value: "all", title: "全部" },
            { value: "enabled", title: "已启用" },
            { value: "disabled", title: "已停用" },
          ] as const
        ).map((item) => (
          <Pressable
            key={item.value}
            accessibilityRole="button"
            accessibilityState={{ selected: filter === item.value }}
            onPress={() => setFilter(item.value)}
            style={[
              styles.filter,
              filter === item.value && { backgroundColor: colors.hover },
            ]}
          >
            <AppText size={13} muted={filter !== item.value} weight="medium">
              {item.title}
            </AppText>
          </Pressable>
        ))}
      </View>
      <ErrorNotice error={error} retry={refresh} safeArea />
      {loading && !items.length ? (
        <LoadingState />
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(item) => item.id}
          refreshing={loading}
          onRefresh={refresh}
          contentContainerStyle={contentStyle}
          renderItem={({ item }) => (
            <View
              style={[styles.taskRow, { borderBottomColor: colors.border }]}
            >
              <View style={styles.taskTop}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={item.name}
                  onPress={() => router.push(`/tasks/${item.id}`)}
                  style={{ flex: 1, paddingVertical: 4 }}
                >
                  <AppText size={16} weight="medium" numberOfLines={1}>
                    {item.name}
                  </AppText>
                  <AppText muted size={13} numberOfLines={1}>
                    {item.prompt}
                  </AppText>
                </Pressable>
                <Switch
                  accessibilityLabel={`启用 ${item.name}`}
                  value={item.enabled}
                  disabled={busy === item.id}
                  onValueChange={(enabled) => void toggle(item, enabled)}
                  trackColor={{ false: colors.border, true: colors.text }}
                  thumbColor={colors.canvas}
                  style={{ transform: [{ scale: 0.83 }] }}
                />
              </View>
              <View style={styles.taskBottom}>
                <View style={{ flex: 1 }}>
                  <AppText muted size={12}>
                    {timing(item)}
                  </AppText>
                  <Pressable onPress={() => router.push(`/tasks/${item.id}`)}>
                    <AppText
                      size={12}
                      style={{
                        color:
                          item.last_status === "failed"
                            ? colors.error
                            : colors.muted,
                      }}
                    >
                      {statusText(item.last_status)}
                      {item.last_run_at
                        ? ` · ${taskDate(item.last_run_at, item.timezone)}`
                        : ""}
                    </AppText>
                  </Pressable>
                </View>
                <ActionIcon
                  icon={Play}
                  size={17}
                  label={`执行 ${item.name}`}
                  disabled={busy === item.id}
                  onPress={() => void run(item)}
                  style={{ width: 36, height: 40 }}
                />
                <ActionIcon
                  icon={Pencil}
                  size={17}
                  label={`编辑 ${item.name}`}
                  onPress={() => setEditing(item)}
                  style={{ width: 36, height: 40 }}
                />
                <ActionIcon
                  icon={ChevronRight}
                  size={17}
                  label={`查看 ${item.name}`}
                  onPress={() => router.push(`/tasks/${item.id}`)}
                  style={{ width: 32, height: 40 }}
                />
              </View>
            </View>
          )}
          ListEmptyComponent={
            <EmptyState icon={CalendarClock} text="暂无任务" />
          }
        />
      )}
      <TaskEditor
        visible={Boolean(editing)}
        task={editing && editing !== "new" ? editing : undefined}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          invalidateLists();
          refresh();
        }}
      />
    </View>
  );
}

export function TaskScreen({ taskId }: { taskId: string }) {
  const { colors, invalidateLists, invalidateVersion } = useApp();
  const contentStyle = usePageContentStyle();
  const [task, setTask] = useState<Schedule | null>(null);
  const [executions, setExecutions] = useState<ScheduleExecution[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = useCallback(() => {
    setLoading(true);
    void Promise.all([api.schedule(taskId), api.scheduleExecutions(taskId)])
      .then(([value, records]) => {
        setTask(value);
        setExecutions(records);
        setError("");
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : "加载失败"),
      )
      .finally(() => setLoading(false));
  }, [taskId]);
  useEffect(refresh, [refresh, invalidateVersion]);
  useEffect(() => {
    if (!executions.some((item) => ["running", "queued"].includes(item.status)))
      return;
    const timer = setInterval(() => {
      void api
        .scheduleExecutions(taskId)
        .then(setExecutions)
        .catch(() => undefined);
    }, 3000);
    return () => clearInterval(timer);
  }, [executions, taskId]);
  async function execute() {
    setBusy(true);
    try {
      const snapshot = await api.runSchedule(taskId);
      invalidateLists();
      const records = await api.scheduleExecutions(taskId);
      setExecutions(records);
      const record = records.find((item) => item.run_id === snapshot.run_id);
      if (record) router.push(`/tasks/${taskId}/runs/${record.id}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "执行失败");
    } finally {
      setBusy(false);
    }
  }
  function remove() {
    Alert.alert("删除任务？", task?.name, [
      { text: "取消", style: "cancel" },
      {
        text: "删除",
        style: "destructive",
        onPress: () =>
          void api
            .deleteSchedule(taskId)
            .then(() => {
              invalidateLists();
              router.replace("/tasks");
            })
            .catch((reason) =>
              setError(reason instanceof Error ? reason.message : "删除失败"),
            ),
      },
    ]);
  }
  return (
    <View style={[screenStyles.fill, { backgroundColor: colors.canvas }]}>
      <PageHeader
        title="任务"
        right={
          <ActionIcon
            icon={Pencil}
            label="编辑任务"
            disabled={!task}
            onPress={() => setEditing(true)}
          />
        }
      />
      <ErrorNotice error={error} retry={refresh} safeArea />
      {loading && !task ? (
        <LoadingState />
      ) : (
        task && (
          <ScrollView contentContainerStyle={contentStyle}>
            <View style={styles.detailHeading}>
              <AppText size={23} weight="semibold" style={{ flex: 1 }}>
                {task.name}
              </AppText>
              <Switch
                value={task.enabled}
                accessibilityLabel="启用任务"
                onValueChange={(enabled) => {
                  void api
                    .saveSchedule({ id: task.id, enabled })
                    .then(setTask)
                    .catch((reason) =>
                      setError(
                        reason instanceof Error ? reason.message : "操作失败",
                      ),
                    );
                }}
                trackColor={{ false: colors.border, true: colors.text }}
                thumbColor={colors.canvas}
              />
            </View>
            <AppText muted size={13}>
              {timing(task)} · {task.timezone}
            </AppText>
            <AppText size={15}>{task.prompt}</AppText>
            <View style={styles.detailActions}>
              <Button
                busy={busy}
                onPress={() => void execute()}
                style={{ flex: 1 }}
              >
                立即执行
              </Button>
              <ActionIcon
                icon={Trash2}
                label="删除任务"
                color={colors.muted}
                onPress={remove}
              />
            </View>
            {task.enabled && task.next_run_at && (
              <AppText muted size={12}>
                下次 {taskDate(task.next_run_at, task.timezone)}
              </AppText>
            )}
            <SectionTitle
              right={
                <AppText muted size={12}>
                  {task.execution_count ?? executions.length} 次
                </AppText>
              }
            >
              执行历史
            </SectionTitle>
            {executions.map((item) => (
              <ExecutionRow
                key={item.id}
                item={item}
                timezone={task.timezone}
                onPress={() => router.push(`/tasks/${taskId}/runs/${item.id}`)}
              />
            ))}
            {!executions.length && (
              <EmptyState icon={Clock3} text="暂无执行记录" />
            )}
          </ScrollView>
        )
      )}
      <TaskEditor
        visible={editing}
        task={task ?? undefined}
        onClose={() => setEditing(false)}
        onSaved={(value) => {
          setTask(value);
          setEditing(false);
          invalidateLists();
        }}
      />
    </View>
  );
}

function ExecutionRow({
  item,
  onPress,
  timezone,
}: {
  item: ScheduleExecution;
  onPress: () => void;
  timezone?: string;
}) {
  const { colors } = useApp();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${statusText(item.status)} ${taskDate(item.started_at, timezone)}`}
      onPress={onPress}
      style={[styles.execution, { borderBottomColor: colors.border }]}
    >
      <View style={styles.executionTop}>
        <View
          style={[
            styles.dot,
            {
              backgroundColor:
                item.status === "failed"
                  ? colors.error
                  : item.status === "completed"
                    ? colors.success
                    : colors.muted,
            },
          ]}
        />
        <AppText size={14} weight="medium">
          {statusText(item.status)}
        </AppText>
        <AppText muted size={12} style={{ flex: 1, textAlign: "right" }}>
          {taskDate(item.started_at, timezone)}
        </AppText>
        <ArrowUpRight size={15} color={colors.muted} />
      </View>
      {item.error || item.output ? (
        <AppText
          size={13}
          muted
          numberOfLines={2}
          style={item.error ? { color: colors.error } : undefined}
        >
          {item.error || item.output}
        </AppText>
      ) : item.artifacts?.length ? (
        <AppText muted size={13}>
          {item.artifacts.length} 个文件
        </AppText>
      ) : null}
    </Pressable>
  );
}

export function TaskExecutionScreen({
  taskId,
  executionId,
}: {
  taskId: string;
  executionId: string;
}) {
  const { colors } = useApp();
  const contentStyle = usePageContentStyle();
  const [execution, setExecution] = useState<ScheduleExecution | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [stopping, setStopping] = useState(false);
  const transcript = useRef<ScrollView>(null);
  const answerOffset = useRef(0);
  const answerFrame = useRef<number | null>(null);
  const [readingTranscript, setReadingTranscript] = useState(false);
  const [viewportHeight, setViewportHeight] = useState(0);
  const updateReadingPosition = useCallback((event: NativeScrollEvent) => {
    const bottom = event.contentSize.height - event.contentOffset.y - event.layoutMeasurement.height < 96;
    setReadingTranscript((previous) => previous === !bottom ? previous : !bottom);
  }, []);
  const viewAnswer = useCallback((offset: number) => {
    setReadingTranscript(false);
    if (answerFrame.current !== null) cancelAnimationFrame(answerFrame.current);
    answerFrame.current = requestAnimationFrame(() => {
      answerFrame.current = null;
      transcript.current?.scrollTo({ y: Math.max(0, answerOffset.current + offset - 8), animated: true });
    });
  }, []);
  useEffect(() => () => { if (answerFrame.current !== null) cancelAnimationFrame(answerFrame.current); }, []);
  const refresh = useCallback(() => {
    void api
      .scheduleExecution(taskId, executionId)
      .then(setExecution)
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : "加载失败"),
      );
  }, [taskId, executionId]);
  const stream = useRunStream(refresh, () => setError("请重新登录"));
  useEffect(() => {
    setLoading(true);
    void api
      .scheduleExecution(taskId, executionId)
      .then((record) => {
        setExecution(record);
        if (record.snapshot) stream.follow(record.snapshot);
        else if (record.run_id)
          void api
            .run(record.run_id)
            .then(stream.follow)
            .catch(() => undefined);
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : "加载失败"),
      )
      .finally(() => setLoading(false));
    return () => stream.clear();
  }, [taskId, executionId]);
  const snapshot = stream.snapshot ?? execution?.snapshot;
  const visibleOutput = snapshot ? unrepresentedOutput(snapshot) : "";
  async function stop() {
    if (!snapshot || stopping) return;
    setStopping(true);
    try {
      stream.follow(await api.cancelRun(snapshot.run_id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "停止失败");
    } finally {
      setStopping(false);
    }
  }
  return (
    <View style={[screenStyles.fill, { backgroundColor: colors.canvas }]}>
      <PageHeader
        title="执行结果"
        right={
          snapshot && isActiveStatus(snapshot.status) ? (
            <ActionIcon
              icon={Square}
              label="停止任务"
              disabled={stopping || snapshot.status === "cancelling"}
              onPress={() => void stop()}
            />
          ) : undefined
        }
      />
      <ErrorNotice error={error} retry={refresh} safeArea />
      {loading ? (
        <LoadingState />
      ) : (
        <ScrollView
          ref={transcript}
          contentContainerStyle={contentStyle}
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
          onLayout={(event) => {
            const measuredHeight = event.nativeEvent.layout.height;
            setViewportHeight((previous) => previous === measuredHeight ? previous : measuredHeight);
          }}
          onScrollBeginDrag={() => setReadingTranscript(true)}
          onMomentumScrollBegin={() => setReadingTranscript(true)}
          onScroll={(event) => updateReadingPosition(event.nativeEvent)}
          onScrollEndDrag={(event) => updateReadingPosition(event.nativeEvent)}
          onMomentumScrollEnd={(event) => updateReadingPosition(event.nativeEvent)}
          scrollEventThrottle={64}
        >
          {execution?.session_id && (
            <Pressable
              onPress={() => router.push(`/c/${execution.session_id}`)}
              style={styles.executionTop}
            >
              <AppText muted size={13}>
                打开对话
              </AppText>
              <ArrowUpRight size={15} color={colors.muted} />
            </Pressable>
          )}
          {snapshot ? (
            <>
              <View onLayout={(event) => { answerOffset.current = event.nativeEvent.layout.y; }}>
                <Activity snapshot={snapshot} readingTranscript={readingTranscript} onViewAnswer={viewAnswer}
                  availableHeight={viewportHeight || undefined} />
              </View>
              {visibleOutput && (
                <ArtifactMarkdown
                  content={visibleOutput}
                  files={snapshot.artifacts}
                  streaming={isActiveStatus(snapshot.status)}
                />
              )}
              <ArtifactCards files={snapshot.artifacts} />
              {snapshot.waiting_input && snapshot.status === "waiting_user" && (
                <WaitingCard
                  waiting={snapshot.waiting_input}
                  onResume={async (answer) => {
                    stream.follow(await api.resumeRun(snapshot.run_id, answer));
                  }}
                />
              )}
            </>
          ) : (
            <>
              <AppText muted size={13}>
                {statusText(execution?.status)} ·{" "}
                {taskDate(execution?.started_at)}
              </AppText>
              {execution?.output && (
                <ArtifactMarkdown
                  content={execution.output}
                  files={execution.artifacts}
                />
              )}
              <ArtifactCards files={execution?.artifacts} />
            </>
          )}
          <ErrorNotice error={execution?.error} />
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  filters: {
    flexDirection: "row",
    gap: 5,
    paddingHorizontal: 18,
    paddingVertical: 8,
  },
  filter: { borderRadius: 16, paddingHorizontal: 13, paddingVertical: 7 },
  taskRow: {
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 4,
  },
  taskTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  taskBottom: { flexDirection: "row", alignItems: "center", gap: 2 },
  detailHeading: { flexDirection: "row", alignItems: "center", gap: 12 },
  detailActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingTop: 4,
  },
  execution: {
    paddingVertical: 14,
    gap: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  executionTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 6, height: 6, borderRadius: 3 },
});
