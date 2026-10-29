import { projectRun, publicReply } from "../../../shared/conversation/projection";
import { t, useI18n, getLocale } from "../lib/i18n";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  CalendarClock,
  Clock3,
  LoaderCircle,
  Pencil,
  Play,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { api, isActiveStatus, userFacingRunError } from "../lib/api";
import { statusLabel } from "../lib/router";
import type {
  Model,
  Project,
  Schedule,
  ScheduleExecution,
  Session,
} from "../lib/types";
import { Modal } from "../components/Modal";
import { MobileMenuButton } from "../components/Sidebar";
import { SelectField } from "../components/ui/Select";
import { FileCards } from "../components/FileCards";
import { RunTranscript } from "../components/RunTranscript";
import { useRunStream } from "../hooks/useRunStream";
import { ReasoningField } from "../components/ReasoningField";
import { WaitingInputCard } from "../components/WaitingInputCard";
import { SessionSearch } from "../components/SessionSearch";
import { scheduleInstant, scheduleWallTime } from "../lib/scheduling";
import "./tasks.css";
const MarkdownContent = lazy(() => import("../components/MarkdownContent"));
function weekdayNames() {
  return Array.from({ length: 7 }, (_, day) => new Intl.DateTimeFormat(getLocale(), { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, day + 1))));
}
function timing(task: Schedule) {
  switch (task.recurrence) {
    case "once":
      return task.once_at
        ? new Date(task.once_at).toLocaleString(getLocale(), {
            timeZone: task.timezone,
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          })
        : t("schedule.once");
    case "daily":
      return t("schedule.dailyAt", { time: task.time_of_day ?? "09:00" });
    case "weekly":
      return t("schedule.weeklyAt", { days: new Intl.ListFormat(getLocale(), { style: "short", type: "conjunction" }).format((task.weekdays ?? []).map((day) => weekdayNames()[day - 1])), time: task.time_of_day ?? "09:00" });
    default:
      return t("schedule.everyMinutes", { count: task.interval_minutes ?? 0 });
  }
}
function taskDate(value?: string, timezone?: string) {
  return value
    ? new Date(value).toLocaleString(getLocale(), {
        timeZone: timezone,
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "";
}
function executionDuration(item: ScheduleExecution) {
  if (!item.started_at || !item.finished_at) return "";
  const seconds = Math.max(
    0,
    Math.round(
      (new Date(item.finished_at).getTime() -
        new Date(item.started_at).getTime()) /
        1000,
    ),
  );
  return seconds < 60
    ? t("duration.seconds", { seconds })
    : t("duration.minutesSeconds", { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
}
function TaskToggle({
  task,
  updating,
  onChange,
}: {
  task: Schedule;
  updating: boolean;
  onChange: (task: Schedule, enabled: boolean) => void;
}) {
  useI18n();
  return (
    <label
      className={`ochi-task-toggle${updating ? " is-updating" : ""}`}
      title={task.enabled ? t("tasks.disable") : t("tasks.enable")}
    >
      <input
        type="checkbox"
        role="switch"
        aria-label={t("tasks.enableName", { name: task.name })}
        aria-busy={updating}
        checked={task.enabled}
        disabled={updating}
        onChange={(event) => onChange(task, event.target.checked)}
      />
      {updating && (
        <LoaderCircle size={17} className="spin" aria-hidden="true" />
      )}
    </label>
  );
}
function MobileTaskTiming({ task }: { task: Schedule }) {
  useI18n();
  return (
    <span className="ochi-task-row__mobile-plan">
      <span>{timing(task)}</span>
      {task.enabled && task.next_run_at
        ? <span>{t("schedule.next")} {taskDate(task.next_run_at, task.timezone)}</span>
        : !task.enabled ? <span>{t("tasks.disabled")}</span> : null}
    </span>
  );
}
export default function TasksPage({
  taskId,
  executionId,
  sessions,
  models,
  projects,
  onNavigate,
  onMenu,
}: {
  taskId?: string;
  executionId?: string;
  sessions: Session[];
  models: Model[];
  projects: Project[];
  onNavigate: (path: string) => void;
  onMenu: () => void;
}) {
  useI18n();
  const [items, setItems] = useState<Schedule[]>([]);
  const [task, setTask] = useState<Schedule | null>(null);
  const [executions, setExecutions] = useState<ScheduleExecution[]>([]);
  const [execution, setExecution] = useState<ScheduleExecution | null>(null);
  const [editing, setEditing] = useState<Partial<Schedule> | null>(null);
  const [deleting, setDeleting] = useState<Schedule | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [updating, setUpdating] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState<"all" | "enabled" | "disabled">("all");
  const [error, setError] = useState("");
  const [choosingSession, setChoosingSession] = useState(false);
  const [chosenSession, setChosenSession] = useState<Session | null>(null);
  const generation = useRef(0);
  const mutations = useRef(0);
  const updatingIds = useRef(new Set<string>());
  const terminal = useCallback(() => {
    const token = generation.current;
    if (taskId)
      void api
        .scheduleExecutions(taskId)
        .then((history) => {
          if (token === generation.current) setExecutions(history);
        })
        .catch(() => undefined);
  }, [taskId]);
  const { snapshot, follow, clear } = useRunStream(terminal, () => undefined);
  const refresh = useCallback(async () => {
    const token = ++generation.current;
    setLoading(true);
    setError("");
    clear();
    try {
      if (taskId) {
        const [value, history] = await Promise.all([
          api.schedule(taskId),
          api.scheduleExecutions(taskId),
        ]);
        if (token !== generation.current) return;
        setTask(value);
        setExecutions(history ?? []);
        if (executionId) {
          const selected = history.find(
            (item) => item.id === executionId || item.run_id === executionId,
          );
          if (!selected) throw new Error(t("tasks.executionMissing"));
          const details = await api.scheduleExecution(taskId, selected.id);
          if (token !== generation.current) return;
          setExecution(details);
          if (details.snapshot) follow(details.snapshot);
          else if (details.run_id) {
            const result = await api.run(details.run_id);
            if (token === generation.current) follow(result);
          }
        } else setExecution(null);
      } else {
        const list = await api.schedules();
        if (token === generation.current) setItems(list);
      }
    } catch (reason) {
      if (token === generation.current)
        setError(reason instanceof Error ? reason.message : t("error.load"));
    } finally {
      if (token === generation.current) setLoading(false);
    }
  }, [taskId, executionId, clear, follow]);
  useEffect(() => {
    void refresh();
    return () => {
      generation.current += 1;
    };
  }, [refresh]);
  useEffect(() => {
    let disposed = false;
    const interval = setInterval(() => {
      if (updatingIds.current.size) return;
      const version = mutations.current;
      if (taskId) {
        void Promise.all([
          api.schedule(taskId),
          api.scheduleExecutions(taskId),
        ])
          .then(([value, history]) => {
            if (!disposed && version === mutations.current) {
              setTask(value);
              setExecutions(history);
            }
          })
          .catch(() => undefined);
      } else {
        void api.schedules().then((list) => {
          if (!disposed && version === mutations.current) setItems(list);
        }).catch(() => undefined);
      }
    }, 10000);
    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }, [taskId]);
  async function save() {
    if (!editing) return;
    setBusy(true);
    setError("");
    mutations.current += 1;
    try {
      // Leave execution metadata and the scheduler-owned next run time untouched.
      const {
        id, name, prompt, recurrence, timezone, time_of_day,
        interval_minutes, weekdays, once_at, enabled, context_mode,
        model_id, effort, project_id, session_id,
      } = editing;
      const value = await api.saveSchedule({
        id, name, prompt, recurrence, timezone, time_of_day,
        interval_minutes, weekdays, once_at, enabled, context_mode,
        model_id, effort, project_id, session_id,
      });
      setEditing(null);
      onNavigate(`/tasks/${value.id}`);
      if (taskId === value.id) void refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("error.save"));
    } finally {
      mutations.current += 1;
      setBusy(false);
    }
  }
  async function toggleTask(item: Schedule, enabled: boolean) {
    if (updatingIds.current.has(item.id)) return;
    const token = generation.current;
    updatingIds.current.add(item.id);
    mutations.current += 1;
    setUpdating((current) => ({ ...current, [item.id]: true }));
    setError("");
    try {
      // PATCH merges with the stored schedule; only change the enabled flag.
      const value = await api.saveSchedule({ id: item.id, enabled });
      if (token !== generation.current) return;
      setItems((current) =>
        current.map((entry) => entry.id === value.id ? value : entry),
      );
      setTask((current) => current?.id === value.id ? value : current);
    } catch (reason) {
      if (token === generation.current)
        setError(reason instanceof Error ? reason.message : t("error.update"));
    } finally {
      updatingIds.current.delete(item.id);
      mutations.current += 1;
      setUpdating((current) => ({ ...current, [item.id]: false }));
    }
  }
  async function openLatest(id: string) {
    setOpeningId(id);
    setError("");
    const token = generation.current;
    try {
      const history = await api.scheduleExecutions(id);
      if (token !== generation.current) return;
      if (history[0]) onNavigate(`/tasks/${id}/runs/${history[0].id}`);
      else onNavigate(`/tasks/${id}`);
    } catch (reason) {
      if (token === generation.current)
        setError(reason instanceof Error ? reason.message : t("error.load"));
    } finally {
      setOpeningId(null);
    }
  }
  async function run(id: string) {
    const token = generation.current;
    setBusy(true);
    setRunningId(id);
    setError("");
    mutations.current += 1;
    try {
      const value = await api.runSchedule(id);
      const history = await api.scheduleExecutions(id);
      if (token !== generation.current) return;
      const latest = history.find((item) => item.run_id === value.run_id);
      if (!value.run_id) {
        const latestExecution = history[0];
        if (latestExecution)
          onNavigate(`/tasks/${id}/runs/${latestExecution.id}`);
        else setError(t("tasks.noResult"));
        return;
      }
      onNavigate(
        `/tasks/${id}/runs/${latest?.run_id ?? latest?.id ?? value.run_id}`,
      );
    } catch (reason) {
      if (token === generation.current)
        setError(reason instanceof Error ? reason.message : t("error.execution"));
    } finally {
      mutations.current += 1;
      setRunningId(null);
      setBusy(false);
    }
  }
  async function removeTask() {
    if (!deleting) return;
    const id = deleting.id;
    setBusy(true);
    setError("");
    mutations.current += 1;
    try {
      await api.deleteSchedule(id);
      setDeleting(null);
      setItems((current) => current.filter((item) => item.id !== id));
      if (taskId === id) onNavigate("/tasks");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("error.delete"));
    } finally {
      mutations.current += 1;
      setBusy(false);
    }
  }
  const create = () => {
    setError("");
    setEditing({
      name: "",
      prompt: "",
      recurrence: "daily",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      time_of_day: "09:00",
      interval_minutes: 60,
      weekdays: [1],
      enabled: true,
      context_mode: "independent",
      model_id: models.find((model) => model.is_default)?.id ?? models[0]?.id,
    });
  };
  const current = snapshot ?? execution?.snapshot;
  const visibleOutput = current ? publicReply(current) : execution?.output ?? "";
  const currentExecution =
    executions.find((item) => item.id === execution?.id) ?? execution;
  const executionStatus =
    current?.status ??
    (execution?.status === "skipped" ? undefined : execution?.status);
  const editingModel =
    models.find((model) => model.id === editing?.model_id) ??
    (!editing?.model_id
      ? (models.find((model) => model.is_default) ?? models[0])
      : undefined);
  const visibleItems = items.filter((item) =>
    filter === "all" || (filter === "enabled" ? item.enabled : !item.enabled),
  );
  const enabledCount = items.filter((item) => item.enabled).length;
  const routeMismatch = Boolean(
    (taskId && task?.id !== taskId) ||
    (executionId && execution?.id !== executionId && execution?.run_id !== executionId),
  );
  return (
    <main className="workspace-page ochi-tasks">
      <header className="chat-header ochi-tasks__header">
        <div className="header-title">
          <MobileMenuButton onClick={onMenu} />
          {taskId && (
            <button
              className="icon-button"
              aria-label={t("tasks.back")}
              onClick={() =>
                onNavigate(executionId ? `/tasks/${taskId}` : "/tasks")
              }
            >
              <ArrowLeft size={18} />
            </button>
          )}
          <h1>{executionId ? t("tasks.result") : t("tasks.title")}</h1>
        </div>
        <button className="secondary-button" onClick={create}>
          <Plus size={16} />
          {t("tasks.create")}
        </button>
      </header>
      <div className="workspace-page-scroll">
        <div className={`page-column ochi-tasks__column${executionId ? " ochi-tasks__column--output" : ""}`}>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {loading || (routeMismatch && !error) ? (
            <div className="panel-loading">
              <LoaderCircle className="spin" size={22} />
            </div>
          ) : routeMismatch ? null : taskId && task ? (
            executionId && execution ? (
              <>
                <div className="ochi-tasks__heading">
                  <div className="ochi-tasks__heading-main">
                    <h2>{task.name}</h2>
                    <div className="ochi-tasks__execution-meta">
                      <span
                        className={`ochi-task-status is-${current?.status ?? execution.status}`}
                      >
                        <span aria-hidden="true" />
                        {statusLabel(current?.status ?? execution.status)}
                      </span>
                      <time dateTime={execution.started_at}>
                        {execution.started_at
                          ? new Date(execution.started_at).toLocaleString(getLocale(), {
                              timeZone: task.timezone,
                              hour12: false,
                            })
                          : ""}
                      </time>
                      <span>{task.timezone}</span>
                      {currentExecution && executionDuration(currentExecution) && <span>{executionDuration(currentExecution)}</span>}
                    </div>
                  </div>
                  {execution.session_id && (
                    <button
                      className="secondary-button"
                      onClick={() => onNavigate(`/c/${execution.session_id}`)}
                    >
                      {t("chat.open")}
                      <ArrowUpRight size={15} />
                    </button>
                  )}
                </div>
                <div className="task-output ochi-tasks__output">
                  <RunTranscript timeline={current ? projectRun(current).entries : []} output={visibleOutput} status={executionStatus}
                    waitingKind={current?.waiting_input?.kind} resource={current?.resource}
                    error={current?.error ?? execution.error} errorCode={current?.error_code ?? execution.error_code}
                    hasArtifacts={Boolean((current?.artifacts ?? execution.artifacts)?.length)}
                    createdAt={current?.created_at ?? execution.started_at}
                    updatedAt={current?.updated_at ?? execution.finished_at}
                    renderBody={(text, _id, streaming) => <Suspense fallback={<p className="markdown-loading">{text}</p>}>
                      <MarkdownContent content={text} isStreaming={streaming} />
                    </Suspense>} />
                </div>
                {current?.status === "waiting_user" && current.waiting_input ? (
                  <WaitingInputCard
                    key={`${current.run_id}:${current.waiting_input.kind ?? "question"}:${current.waiting_input.question}`}
                    waiting={current.waiting_input}
                    runId={current.run_id}
                    onResume={async (id, answer) => {
                      const result = await api.resumeRun(id, answer);
                      follow(result);
                    }}
                  />
                ) : null}
                <FileCards files={current?.artifacts ?? execution.artifacts} />
              </>
            ) : (
              <>
                <div className="ochi-tasks__heading">
                  <div className="ochi-tasks__heading-main">
                    <h2>{task.name}</h2>
                    <div className="ochi-tasks__timing">
                      <Clock3 size={15} />
                      {timing(task)}
                      <span>{task.timezone}</span>
                    </div>
                  </div>
                  <div className="ochi-tasks__detail-actions">
                    <div className="ochi-tasks__enabled">
                      <span>{task.enabled ? t("tasks.enabled") : t("tasks.disabled")}</span>
                      <TaskToggle task={task} updating={Boolean(updating[task.id])}
                        onChange={(item, enabled) => void toggleTask(item, enabled)} />
                    </div>
                    <button
                      className="secondary-button"
                      disabled={busy || Boolean(updating[task.id])}
                      onClick={() => void run(task.id)}
                    >
                      {runningId === task.id ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}
                      {t("tasks.run")}
                    </button>
                    <button className="secondary-button" disabled={busy || Boolean(updating[task.id])}
                      onClick={() => { setError(""); setEditing(task); }}
                    >
                      <Pencil size={15} />
                      {t("common.edit")}
                    </button>
                    <button className="icon-button ochi-tasks__delete" disabled={busy || Boolean(updating[task.id])}
                      aria-label={t("tasks.delete")} title={t("tasks.delete")} onClick={() => setDeleting(task)}>
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
                <div className="ochi-tasks__prompt">{task.prompt}</div>
                <div className="ochi-tasks__facts">
                  <span>
                    {task.context_mode === "session" ? t("tasks.continuous") : t("tasks.isolated")}
                  </span>
                  {task.project_id && (
                    <button
                      className="text-button"
                      onClick={() => onNavigate(`/projects/${task.project_id}`)}
                    >
                      {
                        projects.find((item) => item.id === task.project_id)
                          ?.name
                      }
                    </button>
                  )}
                  <span>
                    {models.find((item) => item.id === task.model_id)?.name}
                  </span>
                  {task.enabled && task.next_run_at && (
                    <span>
                      {t("schedule.next")} {taskDate(task.next_run_at, task.timezone)}
                    </span>
                  )}
                </div>
                <div className="ochi-tasks__section-heading">
                  <h3>{t("tasks.history")}</h3>
                  <span>{t("tasks.executionCount", { count: task.execution_count ?? executions.length })}</span>
                </div>
                <div className="ochi-executions">
                  {executions.map((item) => (
                    <button
                      key={item.id}
                      className="ochi-execution"
                      onClick={() =>
                        onNavigate(
                          `/tasks/${task.id}/runs/${item.id}`,
                        )
                      }
                    >
                      <span className={`ochi-task-status is-${item.status}`}>
                        <span aria-hidden="true" />
                        {statusLabel(item.status)}
                      </span>
                      <time className="ochi-execution__time" dateTime={item.started_at}>
                        {taskDate(item.started_at, task.timezone)}
                      </time>
                      <span className={`ochi-execution__preview${item.error || item.error_code ? " is-error" : ""}`}>
                        {item.error || item.error_code ? userFacingRunError(item.error, Boolean(item.artifacts?.length), item.error_code) : item.output?.slice(0, 180) || (item.artifacts?.length ? t("file.count", { count: item.artifacts.length }) : "")}
                      </span>
                      <span className="ochi-execution__duration">{executionDuration(item)}</span>
                      <ArrowUpRight size={15} />
                    </button>
                  ))}
                  {!executions.length && (
                    <div className="ochi-tasks__empty">{t("tasks.emptyHistory")}</div>
                  )}
                </div>
              </>
            )
          ) : (
            <>
              <div className="ochi-tasks__list-toolbar">
                <div className="ochi-tasks__filters" role="group" aria-label={t("tasks.filter")}>
                  {([
                    ["all", t("common.all"), items.length],
                    ["enabled", t("tasks.enabled"), enabledCount],
                    ["disabled", t("tasks.disabled"), items.length - enabledCount],
                  ] as const).map(([value, label, count]) => (
                    <button key={value} className={filter === value ? "is-selected" : ""}
                      aria-pressed={filter === value} onClick={() => setFilter(value)}>
                      {label}<span>{count}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="ochi-task-list">
                {visibleItems.length > 0 && <div className="ochi-task-list__columns" aria-hidden="true">
                  <span>{t("tasks.task")}</span><span>{t("schedule.title")}</span><span>{t("tasks.latestRun")}</span><span /> <span>{t("tasks.enableLabel")}</span>
                </div>}
                {visibleItems.map((item) => (
                  <article key={item.id} className="ochi-task-row">
                    <button
                      className="ochi-task-row__main"
                      onClick={() => onNavigate(`/tasks/${item.id}`)}
                    >
                      <h3>{item.name}</h3>
                      <p>{item.prompt}</p>
                    </button>
                    <div className="ochi-task-row__schedule" title={item.timezone}>
                      <span>{timing(item)}</span>
                      <small>
                        {item.enabled && item.next_run_at
                          ? t("schedule.nextAt", { time: taskDate(item.next_run_at, item.timezone) })
                          : item.enabled ? "" : t("tasks.disabled")}
                      </small>
                    </div>
                    {item.last_status ? <button className="ochi-task-row__result"
                      aria-label={t("tasks.viewLatest", { name: item.name })}
                      title={item.last_error || item.last_error_code ? userFacingRunError(item.last_error, false, item.last_error_code) : t("tasks.viewResult")} disabled={openingId !== null}
                      onClick={() => void openLatest(item.id)}>
                      <MobileTaskTiming task={item} />
                      <span className="ochi-task-row__recent">
                        <span className={`ochi-task-status is-${item.last_status}`}>
                          {openingId === item.id ? <LoaderCircle size={14} className="spin" /> : <span aria-hidden="true" />}
                          {statusLabel(item.last_status)}
                          <ArrowUpRight size={14} />
                        </span>
                        <small>{taskDate(item.last_run_at, item.timezone)}</small>
                      </span>
                    </button> : <span className="ochi-task-row__no-result">
                      <MobileTaskTiming task={item} /><span>{t("tasks.notRun")}</span>
                    </span>}
                    <div className="ochi-task-row__actions">
                      <button className="icon-button" aria-label={t("tasks.runName", { name: item.name })}
                        title={t("tasks.runNow")} disabled={busy || Boolean(updating[item.id])} onClick={() => void run(item.id)}>
                        {runningId === item.id ? <LoaderCircle size={16} className="spin" /> : <Play size={16} />}
                      </button>
                      <button className="icon-button" aria-label={t("tasks.editName", { name: item.name })}
                        title={t("tasks.edit")} disabled={busy || Boolean(updating[item.id])}
                        onClick={() => { setError(""); setEditing(item); }}>
                        <Pencil size={16} />
                      </button>
                    </div>
                    <TaskToggle task={item} updating={Boolean(updating[item.id])}
                      onChange={(value, enabled) => void toggleTask(value, enabled)} />
                  </article>
                ))}
              </div>
              {!visibleItems.length && (
                <div className="ochi-tasks__empty">
                  <CalendarClock size={23} />
                  <span>{items.length ? t("tasks.emptyFiltered") : t("tasks.empty")}</span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {editing && (
        <Modal
          title={editing.id ? t("tasks.edit") : t("tasks.create")}
          className="ochi-task-editor"
          onClose={() => setEditing(null)}
          size="form"
          footer={
            <div className="modal-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setEditing(null)}
              >
                {t("common.cancel")}
              </button>
              <button
                type="submit"
                form="task-editor"
                className="primary-button"
                disabled={
                  busy ||
                  (editing.context_mode === "session" && !editing.session_id) ||
                  (editing.recurrence === "weekly" && !editing.weekdays?.length)
                }
              >
                {t("common.save")}
              </button>
            </div>
          }
        >
          <form
            id="task-editor"
            className="admin-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label className="form-field">
              <span>{t("common.name")}</span>
              <input
                required
                autoFocus
                value={editing.name ?? ""}
                onChange={(event) =>
                  setEditing({ ...editing, name: event.target.value })
                }
              />
            </label>
            <label className="form-field">
              <span>{t("tasks.task")}</span>
              <textarea
                rows={4}
                required
                value={editing.prompt ?? ""}
                onChange={(event) =>
                  setEditing({ ...editing, prompt: event.target.value })
                }
              />
            </label>
            <div className="form-grid">
              <label className="form-field">
                <span>{t("schedule.frequency")}</span>
                <SelectField
                  value={editing.recurrence ?? "interval"}
                  options={[
                    { value: "once", label: t("schedule.once") },
                    { value: "daily", label: t("schedule.daily") },
                    { value: "weekly", label: t("schedule.weekly") },
                    { value: "interval", label: t("schedule.interval") },
                  ]}
                  onChange={(value) =>
                    setEditing({
                      ...editing,
                      recurrence: value as Schedule["recurrence"],
                    })
                  }
                />
              </label>
              {editing.recurrence === "interval" ? (
                <label className="form-field">
                  <span>{t("schedule.intervalMinutes")}</span>
                  <input
                    type="number"
                    min={1}
                    required
                    value={editing.interval_minutes ?? 60}
                    onChange={(event) =>
                      setEditing({
                        ...editing,
                        interval_minutes: Number(event.target.value),
                      })
                    }
                  />
                </label>
              ) : editing.recurrence === "once" ? (
                <label className="form-field">
                  <span>{t("schedule.dateTime")}</span>
                  <input
                    type="datetime-local"
                    required
                    value={scheduleWallTime(
                      editing.once_at,
                      editing.timezone ?? "Asia/Shanghai",
                    )}
                    onChange={(event) => {
                      try {
                        setEditing({
                          ...editing,
                          once_at: scheduleInstant(
                            event.target.value,
                            editing.timezone ?? "Asia/Shanghai",
                          ),
                        });
                        setError("");
                      } catch (reason) {
                        setError(
                          reason instanceof Error
                            ? reason.message
                            : t("schedule.invalidDate"),
                        );
                      }
                    }}
                  />
                </label>
              ) : (
                <label className="form-field">
                  <span>{t("schedule.time")}</span>
                  <input
                    type="time"
                    required
                    value={editing.time_of_day ?? "09:00"}
                    onChange={(event) =>
                      setEditing({
                        ...editing,
                        time_of_day: event.target.value,
                      })
                    }
                  />
                </label>
              )}
            </div>
            {editing.recurrence === "weekly" && (
              <div className="weekday-picker">
                {weekdayNames().map((name, index) => (
                  <button
                    key={name}
                    type="button"
                    className={
                      editing.weekdays?.includes(index + 1) ? "selected" : ""
                    }
                    aria-pressed={
                      editing.weekdays?.includes(index + 1) ?? false
                    }
                    aria-label={name}
                    onClick={() =>
                      setEditing({
                        ...editing,
                        weekdays: editing.weekdays?.includes(index + 1)
                          ? editing.weekdays.filter((day) => day !== index + 1)
                          : [...(editing.weekdays ?? []), index + 1],
                      })
                    }
                  >
                    {name}
                  </button>
                ))}
              </div>
            )}
            <details className="advanced-section">
              <summary>{t("common.advanced")}</summary>
              <label className="form-field">
                <span>{t("schedule.timezone")}</span>
                <input
                  required
                  value={editing.timezone ?? "Asia/Shanghai"}
                  onChange={(event) =>
                    setEditing({ ...editing, timezone: event.target.value })
                  }
                />
              </label>
              <div className="form-grid">
                <label className="form-field">
                  <span>{t("projects.title")}</span>
                  <SelectField
                    value={editing.project_id ?? ""}
                    options={[
                      { value: "", label: t("projects.none") },
                      ...projects.map((project) => ({
                        value: project.id,
                        label: project.name,
                      })),
                    ]}
                    onChange={(project_id) =>
                      setEditing({ ...editing, project_id, session_id: "" })
                    }
                  />
                </label>
                <label className="form-field">
                  <span>{t("model.title")}</span>
                  <SelectField
                    value={editing.model_id ?? ""}
                    options={[
                      { value: "", label: t("model.default") },
                      ...models.map((model) => ({
                        value: model.id,
                        label: model.name,
                      })),
                    ]}
                    onChange={(model_id) =>
                      setEditing({
                        ...editing,
                        model_id,
                        effort:
                          (
                            models.find((model) => model.id === model_id) ??
                            models.find((model) => model.is_default)
                          )?.default_effort ?? "",
                      })
                    }
                  />
                </label>
              </div>
              <ReasoningField
                model={editingModel}
                effort={editing.effort}
                onChange={(effort) => setEditing({ ...editing, effort })}
              />
              <label className="form-field">
                <span>{t("schedule.context")}</span>
                <SelectField
                  value={editing.context_mode ?? "independent"}
                  options={[
                    { value: "independent", label: t("schedule.isolated") },
                    { value: "session", label: t("schedule.reuse") },
                  ]}
                  onChange={(value) =>
                    setEditing({
                      ...editing,
                      context_mode: value as Schedule["context_mode"],
                    })
                  }
                />
              </label>
              {editing.context_mode === "session" && (
                <div className="form-field">
                  <span>{t("chat.conversations")}</span>
                  <button type="button" className="choice-trigger" onClick={() => setChoosingSession(true)}>
                    <span>{chosenSession && chosenSession.id === editing.session_id ? chosenSession.title : sessions.find((item) => item.id === editing.session_id)?.title ?? (editing.session_id ? t("chat.selected") : t("chat.choose"))}</span>
                    <Search size={15} />
                  </button>
                </div>
              )}
            </details>
            <label className="toggle-field">
              <span>{t("tasks.enableLabel")}</span>
              <input
                type="checkbox"
                role="switch"
                checked={editing.enabled ?? true}
                onChange={(event) =>
                  setEditing({ ...editing, enabled: event.target.checked })
                }
              />
            </label>
            {error && <p className="form-error">{error}</p>}
          </form>
        </Modal>
      )}
      {choosingSession && editing && <SessionSearch projectId={editing.project_id} onClose={() => setChoosingSession(false)}
        onSelect={(session_id) => setEditing((current) => current ? { ...current, session_id } : current)} onSelectSession={setChosenSession} />}
      {deleting && (
        <Modal
          title={t("tasks.deleteConfirm")}
          className="ochi-task-editor"
          onClose={() => setDeleting(null)}
          size="small"
          footer={
            <div className="modal-actions">
              <button
                className="secondary-button"
                onClick={() => setDeleting(null)}
              >
                {t("common.cancel")}
              </button>
              <button
                className="danger-button"
                disabled={busy}
                onClick={() => void removeTask()}
              >
                {t("common.delete")}
              </button>
            </div>
          }
        >
          <p>{deleting.name}</p>
          {error && <p className="form-error" role="alert">{error}</p>}
        </Modal>
      )}
    </main>
  );
}
