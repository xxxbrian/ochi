import { publicReply } from "../../../../shared/conversation/projection";
import { t, useAdminI18n, getLocale, translateError } from "./i18n";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Cpu,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { adminApi } from "../../lib/api";
import type { AdminRun, AdminRunDetail, AdminRunFilter, AdminRunPage, AdminRunStats, Model, Step, User, Workspace } from "../../lib/types";
import { Modal } from "../../components/Modal";
import { SelectField } from "../../components/ui/Select";
import { statusLabel } from "../../lib/router";
import { ErrorNotice, Field, Toggle } from "./Fields";
import { StepList } from "../../components/ProcessDetails";
import { FileCards } from "../../components/FileCards";
import { RequestDiagnostics } from "./RequestDiagnostics";
import { UpdateCard } from "./UpdateCard";

const MarkdownContent = lazy(() => import("../../components/MarkdownContent"));

export function UsersPage() {
  useAdminI18n();
  const [users, setUsers] = useState<User[]>([]);
  const [editor, setEditor] = useState<
    (Partial<User> & { password?: string }) | null
  >(null);
  const [deleting, setDeleting] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setUsers(await adminApi.users());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("loadFailed"));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  async function save() {
    if (!editor) return;
    setBusy(true);
    try {
      const value = {
        id: editor.id,
        username: editor.username,
        display_name: editor.display_name,
        role: editor.role,
        enabled: editor.enabled,
        ...(editor.password ? { password: editor.password } : {}),
      };
      await adminApi.save<User>("users", value, Boolean(value.id));
      setEditor(null);
      void refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("saveFailed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="admin-page-heading">
        <h2>{t("users")}</h2>
        <button
          className="primary-button"
          onClick={() =>
            setEditor({
              username: "",
              display_name: "",
              role: "user",
              enabled: true,
              password: "",
            })
          }
        >
          <Plus size={16} />
          {t("addUser")}</button>
      </div>
      <ErrorNotice error={error} />
      {loading ? (
        <div className="panel-loading">
          <LoaderCircle className="spin" size={22} />
        </div>
      ) : (
        <div className="users-list">
          {users.map((user) => (
            <article key={user.id}>
              <span className="account-avatar">
                {(user.display_name || user.username).slice(0, 1)}
              </span>
              <div className="user-row-main">
                <strong>{user.display_name || user.username}</strong>
                <span>{user.username}</span>
              </div>
              <span className="admin-user-role">{user.role === "admin" ? t("administrator") : t("userRole")}</span>
              <span className={`admin-state${user.enabled !== false ? " is-enabled" : ""}`}>
                <i />{user.enabled !== false ? t("enabled") : t("disabled")}
              </span>
              <div className="admin-row-actions">
                <button className="icon-button" aria-label={t("editUserNamed", { name: user.display_name || user.username })}
                  title={t("editUser")} onClick={() => setEditor({ ...user, password: "" })}>
                  <Pencil size={16} />
                </button>
                <button className="icon-button admin-delete-action" aria-label={t("deleteUserNamed", { name: user.display_name || user.username })}
                  title={t("deleteUser")} onClick={() => setDeleting(user)}>
                  <Trash2 size={16} />
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      {editor && (
        <Modal
          className="ochi-admin-modal"
          title={editor.id ? t("editUser") : t("addUser")}
          onClose={() => setEditor(null)}
          footer={
            <div className="modal-actions">
              <button
                type="submit"
                form="user-editor"
                className="primary-button"
                disabled={busy}
              >
                {t("save")}</button>
            </div>
          }
        >
          <form
            id="user-editor"
            className="admin-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <Field title={t("account")}>
              <input
                required
                readOnly={Boolean(editor.id)}
                value={editor.username ?? ""}
                onChange={(event) =>
                  setEditor({ ...editor, username: event.target.value })
                }
              />
            </Field>
            <Field title={t("displayName")}>
              <input
                value={editor.display_name ?? ""}
                onChange={(event) =>
                  setEditor({ ...editor, display_name: event.target.value })
                }
              />
            </Field>
            <Field title={editor.id ? t("newPassword") : t("password")}>
              <input
                type="password"
                required={!editor.id}
                value={editor.password ?? ""}
                autoComplete="new-password"
                onChange={(event) =>
                  setEditor({ ...editor, password: event.target.value })
                }
              />
            </Field>
            <Field title={t("role")}>
              <SelectField
                value={editor.role ?? "user"}
                options={[
                  { value: "user", label: t("userRole") },
                  { value: "admin", label: t("administrator") },
                ]}
                onChange={(role) =>
                  setEditor({ ...editor, role: role as User["role"] })
                }
              />
            </Field>
            <Toggle
              title={t("enable")}
              value={editor.enabled ?? true}
              onChange={(enabled) => setEditor({ ...editor, enabled })}
            />
            <ErrorNotice error={error} />
          </form>
        </Modal>
      )}
      {deleting && (
        <Modal
          className="ochi-admin-modal"
          title={t("deleteUserQuestion")}
          onClose={() => setDeleting(null)}
          size="small"
          footer={
            <div className="modal-actions">
              <button
                className="secondary-button"
                onClick={() => setDeleting(null)}
              >
                {t("cancel")}</button>
              <button
                className="danger-button"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void adminApi
                    .remove("users", deleting.id)
                    .then(() => {
                      setDeleting(null);
                      return refresh();
                    })
                    .catch((reason: Error) => setError(reason.message))
                    .finally(() => setBusy(false));
                }}
              >
                {t("delete")}</button>
            </div>
          }
        >
          <p>{deleting.display_name || deleting.username}</p>
        </Modal>
      )}
    </>
  );
}
export function SystemPage() {
  useAdminI18n();
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [debugMode, setDebugMode] = useState(false);
  const [debugBusy, setDebugBusy] = useState(false);
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let disposed = false;
    Promise.all([adminApi.settings(), adminApi.models()])
      .then(([value, available]) => {
        if (!disposed) {
          setSettings(value);
          setDebugMode(value.debug_mode === true);
          setModels(available);
        }
      })
      .catch((reason: Error) => {
        if (!disposed) setError(reason.message);
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, []);
  async function saveDebugMode(debug_mode: boolean) {
    setDebugBusy(true);
    setError("");
    setNotice("");
    try {
      const value = await adminApi.saveSettings({ debug_mode });
      setDebugMode(value.debug_mode === true);
      setNotice(value.debug_mode === true ? t("debugEnabled") : t("debugDisabled"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("saveFailed"));
    } finally {
      setDebugBusy(false);
    }
  }
  if (loading)
    return (
      <div className="panel-loading">
        <LoaderCircle className="spin" size={22} />
      </div>
    );
  return (
    <>
      <div className="admin-page-heading">
        <h2>{t("system")}</h2>
      </div>
      <ErrorNotice error={error} notice={notice} />
      <form
        className="admin-form system-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || debugBusy) return;
          setBusy(true);
          setError("");
          setNotice("");
          const { debug_mode: _debugMode, ...draft } = settings;
          void adminApi
            .saveSettings(draft)
            .then((value) => {
              setSettings(value);
              setNotice(t("saved"));
            })
            .catch((reason: Error) => setError(reason.message))
            .finally(() => setBusy(false));
        }}
      >
        <section className="settings-card">
          <h3>{t("auxiliaryModels")}</h3>
          {[
            {
              key: "compaction_model_id",
              title: t("contextCompaction"),
              kind: "chat",
              fallback: t("useMainModel"),
            },
            {
              key: "memory_model_id",
              title: t("memoryExtraction"),
              kind: "chat",
              fallback: t("useMainModel"),
            },
            {
              key: "title_model_id",
              title: t("conversationTitles"),
              kind: "chat",
              fallback: t("useMainModel"),
            },
            {
              key: "image_model_id",
              title: t("imageGeneration"),
              kind: "image",
              fallback: t("firstEnabledImageModel"),
            },
            {
              key: "embedding_model_id",
              title: t("memoryEmbeddings"),
              kind: "embedding",
              fallback: t("localBGESmall"),
            },
          ].map((slot) => (
            <Field title={slot.title} key={slot.key}>
              <SelectField
                value={String(settings[slot.key] ?? "")}
                onChange={(value) =>
                  setSettings({ ...settings, [slot.key]: value })
                }
                options={[
                  { value: "", label: slot.fallback },
                  ...models
                    .filter(
                      (model) =>
                        ((model as Model & { kind?: string }).kind ??
                          "chat") === slot.kind,
                    )
                    .map((model) => ({
                      value: model.id,
                      label: `${model.name} · ${model.provider_name ?? model.provider_id}`,
                    })),
                ]}
              />
            </Field>
          ))}
        </section>
        <section className="settings-card">
          <h3>Agent</h3>
          <Field title={t("additionalInstructions")}>
            <textarea
              rows={14}
              placeholder={t("optional")}
              value={String(settings.system_prompt ?? "")}
              onChange={(event) =>
                setSettings({ ...settings, system_prompt: event.target.value })
              }
            />
          </Field>
          <Field title={t("maxToolRounds")}>
            <input
              type="number"
              min={1}
              max={200}
              value={Number(settings.max_tool_rounds) || 40}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  max_tool_rounds: Number(event.target.value),
                })
              }
            />
          </Field>
        </section>
        <section className="settings-card">
          <h3>{t("diagnostics")}</h3>
          <Toggle
            title={t("debugMode")}
            value={debugMode}
            disabled={busy || debugBusy}
            onChange={(debug_mode) => void saveDebugMode(debug_mode)}
          />
          <p className="settings-note">
            {t("debugModeHint")}{debugBusy ? t("savingEllipsis") : t("debugImmediateHint")}{t("debugHistoryHint")}</p>
        </section>
        <div className="form-footer">
          <button className="primary-button" disabled={busy || debugBusy}>
            {busy && <LoaderCircle className="spin" size={15} />}{t("save")}</button>
        </div>
      </form>
      <UpdateCard />
    </>
  );
}
export function WorkspacesPage() {
  useAdminI18n();
  const [items, setItems] = useState<Workspace[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<Workspace | null>(null);
  const refresh = useCallback(async () => {
    try {
      const [values, accounts] = await Promise.all([
        adminApi.workspaces(),
        adminApi.users(),
      ]);
      setItems(values);
      setUsers(accounts);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("loadFailed"));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  async function action(item: Workspace, name: string) {
    setBusy(item.user_id);
    try {
      await adminApi.workspace(item.user_id, name);
      setConfirm(null);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("operationFailed"));
    } finally {
      setBusy("");
    }
  }
  function workspaceName(item: Workspace) {
    return item.kind === "control"
      ? t("pluginControlWorkspace")
      : users.find((user) => user.id === item.user_id)?.display_name || item.user_id;
  }
  return (
    <>
      <div className="admin-page-heading">
        <h2>{t("workspaces")}</h2>
        <button
          className="icon-button"
          aria-label={t("refresh")}
          onClick={() => void refresh()}
        >
          <RefreshCw size={18} />
        </button>
      </div>
      <ErrorNotice error={error} />
      {loading ? (
        <div className="panel-loading">
          <LoaderCircle className="spin" size={22} />
        </div>
      ) : (
        <div className="workspace-list">
          {items.map((item) => (
            <article key={item.user_id}>
              <span className="integration-icon"><Cpu size={18} /></span>
              <div className="workspace-row-main">
                <strong>
                  {workspaceName(item)}
                </strong>
                <span>{item.image}</span>
                <small>{item.container}</small>
                {item.kind === "control" && <small>{t("pluginControlDescription")}</small>}
                {item.update_available && <small>{t("workspaceImageUpdateAvailable")}</small>}
              </div>
              <span className={`admin-state${item.running ? " is-enabled" : ""}`}>
                <i />{item.running ? t("running") : item.state || t("notStarted")}
              </span>
              <div className="workspace-row-actions">
                <button
                  className="secondary-button"
                  disabled={busy === item.user_id}
                  onClick={() =>
                    void action(item, item.running ? "stop" : "start")
                  }
                >
                  {item.running ? t("stop") : t("startAction")}
                </button>
                <button className="secondary-button" disabled={busy === item.user_id}
                  onClick={() => setConfirm(item)}>{t("rebuild")}</button>
              </div>
            </article>
          ))}
          {!items.length && <div className="empty-page">{t("noWorkspaces")}</div>}
        </div>
      )}
      {confirm && (
        <Modal
          className="ochi-admin-modal"
          title={t("rebuildWorkspaceQuestion")}
          onClose={() => setConfirm(null)}
          size="small"
          footer={
            <div className="modal-actions">
              <button
                className="secondary-button"
                onClick={() => setConfirm(null)}
              >
                {t("cancel")}</button>
              <button
                className="primary-button"
                disabled={busy === confirm.user_id}
                onClick={() => void action(confirm, "rebuild")}
              >
                {t("rebuild")}</button>
            </div>
          }
        >
          <p>
            {workspaceName(confirm)}
          </p>
        </Modal>
      )}
    </>
  );
}
function formatDuration(milliseconds?: number | null) {
  if (milliseconds == null) return "—";
  const seconds = milliseconds / 1000;
  if (seconds < 1) return `${Math.round(milliseconds)} ms`;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  return `${Math.floor(seconds / 60)} m ${Math.round(seconds % 60)} s`;
}
function formatTokens(tokens?: number | null) {
  return tokens == null ? "—" : tokens.toLocaleString(getLocale());
}
function RunStatusBadge({ run }: { run: Pick<AdminRun, "status" | "error" | "error_code"> }) {
  useAdminI18n();
  const error = translateError(run.error_code) ?? run.error;
  return <span className={`run-status run-status-${run.status}`} title={error || undefined}>
    <i />{statusLabel(run.status)}{error && <CircleAlert size={12} />}
  </span>;
}
function ReadOnlySteps({ steps }: { steps: Step[] }) {
  useAdminI18n();
  return <div className="admin-readonly-steps">{steps.map(step => {
    const scope = ["command", "url", "path", "query"].map(key => step.arguments?.[key]).find(value => typeof value === "string") as string | undefined;
    let result: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(step.output ?? "");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) result = parsed as Record<string, unknown>;
    } catch { /* Plain-text output needs no JSON projection. */ }
    const text = result ? [result.stdout, result.stderr, result.content, result.message, result.error].filter(value => typeof value === "string").join("\n") : step.output;
    return <details key={step.id}>
      <summary><RunStatusBadge run={{ status: step.status === "running" ? "running" : step.status === "failed" ? "failed" : "completed" }} /><strong>{step.name}</strong><span>{scope}</span></summary>
      {scope && <pre>{scope}</pre>}
      {text && <pre>{text.slice(0, 32000)}</pre>}
      {result && <details className="technical-details"><summary>{t("returnedData")}</summary><pre>{JSON.stringify(result, null, 2).slice(0, 64000)}</pre></details>}
    </details>;
  })}</div>;
}
function statusOptions() { return [
  { value: "", label: t("allStatuses") },
  ...["completed", "running", "queued", "waiting_user", "waiting_resource", "failed", "interrupted", "cancelled", "cancelling"].map(value => ({ value, label: statusLabel(value) })),
]; }
function dateOptions() { return [
  { value: "today", label: t("today") },
  { value: "7", label: t("last7Days") },
  { value: "30", label: t("last30Days") },
  { value: "90", label: t("last90Days") },
]; }

export function RunsPage({ currentUserID, onNavigate }: { currentUserID: string; onNavigate: (path: string) => void }) {
  useAdminI18n();
  const [page, setPage] = useState<AdminRunPage | null>(null);
  const [stats, setStats] = useState<AdminRunStats | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [selected, setSelected] = useState<AdminRun | null>(null);
  const [detail, setDetail] = useState<AdminRunDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailTab, setDetailTab] = useState("result");
  const [view, setView] = useState("records");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [model, setModel] = useState("");
  const [account, setAccount] = useState("");
  const [period, setPeriod] = useState("30");
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [detailRevision, setDetailRevision] = useState(0);
  const limit = 30;
  useEffect(() => {
    const timer = window.setTimeout(() => { setSearch(query.trim()); setOffset(0); }, 250);
    return () => window.clearTimeout(timer);
  }, [query]);
  const filters = useMemo<AdminRunFilter>(() => {
    const from = new Date();
    if (period === "today") from.setHours(0, 0, 0, 0);
    else from.setDate(from.getDate() - Number(period));
    return { q: search, status, model_id: model, user_id: account, from: from.toISOString() };
  }, [search, status, model, account, period, revision]);
  useEffect(() => {
    let disposed = false;
    Promise.all([adminApi.models(), adminApi.users()])
      .then(([available, accounts]) => { if (!disposed) { setModels(available); setUsers(accounts); } })
      .catch((reason: Error) => { if (!disposed) setError(reason.message); });
    return () => { disposed = true; };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    Promise.all([
      adminApi.runs({ ...filters, offset, limit }, controller.signal),
      adminApi.runStats(filters, controller.signal),
    ]).then(([value, totals]) => { if (!controller.signal.aborted) { setPage(value); setStats(totals); } })
      .catch((reason: Error) => { if (!controller.signal.aborted) setError(reason.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [filters, offset]);
  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    const controller = new AbortController();
    setDetailLoading(true); setDetailError(""); setDetail(null);
    adminApi.run(selected.run_id, controller.signal)
      .then(value => { if (!controller.signal.aborted) setDetail(value); })
      .catch((reason: Error) => { if (!controller.signal.aborted) setDetailError(reason.message); })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [selected?.run_id, detailRevision]);
  function selectRun(run: AdminRun) { setDetailTab("result"); setSelected(run); }
  const current = detail ?? selected;
  return <>
    <div className="admin-page-heading">
      <h2>{t("runRecords")}</h2>
      <div className="toolbar-actions">
        <SelectField label={t("statisticsRange")} value={period} options={dateOptions()} onChange={value => { setPeriod(value); setOffset(0); }} />
        <button className="icon-button" aria-label={t("refreshRuns")} disabled={loading} onClick={() => setRevision(value => value + 1)}>
          <RefreshCw size={16} className={loading ? "spin" : undefined} />
        </button>
      </div>
    </div>
    <ErrorNotice error={error} />
    <div className="run-view-tabs" role="tablist" aria-label={t("runView")}>
      {[{ id: "records", label: t("records") }, { id: "overview", label: t("overview") }].map(tab =>
        <button key={tab.id} id={`run-tab-${tab.id}`} role="tab" aria-selected={view === tab.id} aria-controls="run-view" className={view === tab.id ? "selected" : ""} onClick={() => setView(tab.id)}>{tab.label}</button>,
      )}
      <span className="run-period-label">{stats ? `${new Date(stats.from).toLocaleDateString(getLocale())} — ${new Date(stats.to).toLocaleDateString(getLocale())}` : ""}</span>
    </div>
    <div className={`run-summary-strip ${loading ? "is-updating" : ""}`} data-view={view} aria-busy={loading}>
      <div><span>{t("runs")}</span><strong>{stats?.runs.toLocaleString(getLocale()) ?? "—"}</strong><small>{stats ? t("runsCompletedActive", { completed: stats.completed, active: stats.active }) : ""}</small></div>
      <div><span>{t("issues")}</span><strong className={stats && stats.failed + stats.interrupted ? "danger" : ""}>{stats ? (stats.failed + stats.interrupted).toLocaleString(getLocale()) : "—"}</strong><small>{stats ? t("runsFailedInterrupted", { failed: stats.failed, interrupted: stats.interrupted }) : ""}</small></div>
      <div><span>{t("inputTokens")}</span><strong>{stats?.usage_reported_runs ? formatTokens(stats.prompt_tokens) : "—"}</strong><small>{stats?.usage_reported_runs ? t("usageCount", { count: stats.usage_reported_runs }) : ""}</small></div>
      <div><span>{t("outputTokens")}</span><strong>{stats?.usage_reported_runs ? formatTokens(stats.completion_tokens) : "—"}</strong><small>{stats?.usage_reported_runs ? t("totalTokensCount", { count: formatTokens(stats.total_tokens) }) : ""}</small></div>
      <div><span>{t("cachedTokens")}</span><strong>{formatTokens(stats?.cached_tokens)}</strong></div>
      <div><span>{t("averageDuration")}</span><strong>{formatDuration(stats?.average_duration_ms)}</strong><small>{stats ? t("cancelledCount", { count: stats.cancelled }) : ""}</small></div>
    </div>
    <div className="runs-filterbar">
      <label className="search-input"><Search size={15} /><input aria-label={t("searchRuns")} value={query} onChange={event => setQuery(event.target.value)} placeholder={t("searchRunsPlaceholder")} /></label>
      <SelectField label={t("runStatus")} value={status} options={statusOptions()} onChange={value => { setStatus(value); setOffset(0); }} />
      <SelectField label={t("filterModel")} value={model} options={[{ value: "", label: t("allModels") }, ...models.map(item => ({ value: item.id, label: item.name }))]} onChange={value => { setModel(value); setOffset(0); }} />
      <SelectField label={t("filterUser")} value={account} options={[{ value: "", label: t("allUsers") }, ...users.map(item => ({ value: item.id, label: item.display_name || item.username }))]} onChange={value => { setAccount(value); setOffset(0); }} />
    </div>
    <section id="run-view" role="tabpanel" aria-labelledby={`run-tab-${view}`}>
    {view === "records" ? <>
      <div className={`admin-table-wrap runs-table-wrap ${loading ? "is-updating" : ""}`} aria-busy={loading}>
        <table className="admin-table runs-table">
          <thead><tr><th>{t("taskUser")}</th><th>{t("model")}</th><th>{t("status")}</th><th className="numeric">{t("duration")}</th><th className="numeric">Tokens</th><th>{t("start")}</th><th><span className="sr-only">{t("details")}</span></th></tr></thead>
          <tbody>{page?.items.map(run => <tr key={run.run_id}>
            <td className="runs-cell-task"><button className="run-task-link" onClick={() => selectRun(run)} title={run.prompt || run.session_title}>
              <strong>{run.prompt || run.session_title || t("newChat")}</strong>
              <small className="run-task-user" title={run.username}>{run.display_name || run.username || "—"}{run.prompt && run.prompt !== run.session_title ? ` · ${run.session_title}` : ""}</small>
            </button></td>
            <td className="runs-cell-model" title={[run.model_name, run.provider_name, run.effort].filter(Boolean).join(" · ")}><span className="table-model-name" title={run.model_name}>{run.model_name || "—"}</span><small className="table-secondary">{[run.provider_name, run.effort].filter(Boolean).join(" · ")}</small></td>
            <td className="runs-cell-status"><RunStatusBadge run={run} /></td>
            <td className="numeric runs-cell-duration" data-label={t("duration")}>{formatDuration(run.duration_ms)}</td>
            <td className="numeric runs-cell-tokens" data-label="Tokens"
              title={t("usageSummary", { input: formatTokens(run.usage?.prompt_tokens), output: formatTokens(run.usage?.completion_tokens), cached: formatTokens(run.usage?.cached_tokens) })}>
              {run.usage?.total_tokens ? formatTokens(run.usage.total_tokens) : "—"}
              <small className="table-secondary">{run.step_count} {t("toolCallsSuffix")}</small>
            </td>
            <td className="table-date runs-cell-time" title={new Date(run.created_at).toLocaleString(getLocale())}>
              <span>{new Date(run.created_at).toLocaleDateString(getLocale(), { month: "short", day: "numeric" })}</span>
              <small>{new Date(run.created_at).toLocaleTimeString(getLocale(), { hour: "2-digit", minute: "2-digit", hour12: false })}</small>
              <span className="run-responsive-user" title={[run.username, run.session_title].filter(Boolean).join(" · ")}>{run.display_name || run.username || "—"}{run.prompt && run.prompt !== run.session_title ? ` · ${run.session_title}` : ""}</span>
            </td>
            <td className="runs-cell-action"><button className="icon-button" aria-label={t("viewRunNamed", { name: run.prompt || run.session_title })} title={t("runDetails")} onClick={() => selectRun(run)}><ArrowUpRight size={16} /></button></td>
          </tr>)}</tbody>
        </table>
        {!page?.items.length && <div className="table-empty">{loading ? <LoaderCircle className="spin" size={18} /> : t("noRecords")}</div>}
      </div>
      <div className="table-pagination">
        <span>{page ? t("recordsRange", { total: page.total, start: page.total ? Math.min(offset + 1, page.total) : 0, end: Math.min(offset + limit, page.total) }) : ""}</span>
        <div><button className="icon-button" aria-label={t("previousRunsPage")} disabled={loading || offset === 0} onClick={() => setOffset(value => Math.max(0, value - limit))}><ChevronLeft size={16} /></button><span>{Math.floor(offset / limit) + 1} / {Math.max(1, Math.ceil((page?.total ?? 0) / limit))}</span><button className="icon-button" aria-label={t("nextRunsPage")} disabled={loading || !page || offset + limit >= page.total} onClick={() => setOffset(value => value + limit)}><ChevronRight size={16} /></button></div>
      </div>
    </> : <div className="admin-table-wrap" aria-busy={loading}>
      <table className="admin-table usage-model-table"><thead><tr><th>{t("modelProvider")}</th><th className="numeric">{t("runs")}</th><th className="numeric">{t("issues")}</th><th className="numeric">Tokens</th><th className="numeric">{t("cache")}</th></tr></thead>
        <tbody>{stats?.models.map(item => <tr key={`${item.model_id}:${item.model_name}`}>
          <td className="usage-cell-name"><strong>{item.model_name || "—"}</strong><small className="table-secondary">{item.provider_name || "—"}</small></td>
          <td className="numeric" data-label={t("runs")}>{formatTokens(item.runs)}</td>
          <td className={`numeric ${item.failed ? "danger" : ""}`} data-label={t("issues")}>{item.failed}</td>
          <td className="numeric" data-label="Tokens" title={t("inputOutputSummary", { input: formatTokens(item.prompt_tokens), output: formatTokens(item.completion_tokens) })}>{item.total_tokens ? formatTokens(item.total_tokens) : "—"}</td>
          <td className="numeric" data-label={t("cache")}>{formatTokens(item.cached_tokens)}</td>
        </tr>)}</tbody>
      </table>{!stats?.models.length && <div className="table-empty">{loading ? <LoaderCircle className="spin" size={18} /> : t("noRecords")}</div>}
    </div>}
    </section>
    {selected && current && <Modal className="ochi-admin-modal" title={t("runDetails")} size="large" onClose={() => setSelected(null)} footer={<div className="modal-actions">
      {current.user_id === currentUserID && <button className="secondary-button" onClick={() => onNavigate(`/c/${current.session_id}`)}>{t("openConversation")}<ArrowUpRight size={14} /></button>}
      <button className="secondary-button" disabled={detailLoading} onClick={() => setDetailRevision(value => value + 1)}><RefreshCw size={14} className={detailLoading ? "spin" : undefined} />{t("refresh")}</button>
    </div>}>
      <div className="run-detail-heading"><strong>{current.session_title || t("newChat")}</strong><RunStatusBadge run={current} /></div>
      <div className="run-detail-meta"><span>{current.display_name || current.username}</span><span>{current.model_name}{current.effort ? ` · ${current.effort}` : ""}</span><span>{new Date(current.created_at).toLocaleString(getLocale(), { hour12: false })}</span><span>{formatDuration(current.duration_ms)}</span></div>
      <div className="run-detail-tabs" role="tablist" aria-label={t("runDetails")}>
        {[{ id: "result", title: t("content") }, { id: "tools", title: t("toolCount", { count: current.step_count }) }, { id: "metadata", title: t("data") }, { id: "requests", title: t("requestDiagnostics") }].map(tab => <button key={tab.id} role="tab" aria-selected={detailTab === tab.id} aria-controls="run-detail-content" className={detailTab === tab.id ? "selected" : ""} onClick={() => setDetailTab(tab.id)}>{tab.title}</button>)}
      </div>
      <ErrorNotice error={detailError} />
      {detailLoading ? <div className="run-detail-loading"><LoaderCircle size={18} className="spin" /></div> : detail && <div id="run-detail-content" role="tabpanel" className="run-detail-content">
        {detailTab === "result" ? <>
          <div className="run-prompt-text">{detail.prompt}</div>
          {(detail.error_code || detail.error) && <pre className="run-error-output">{translateError(detail.error_code) ?? detail.error}</pre>}
          {publicReply(detail) && <div className="markdown-body"><Suspense fallback={<div>{publicReply(detail)}</div>}><MarkdownContent content={publicReply(detail)} isStreaming={false} /></Suspense></div>}
          {detail.artifacts.length > 0 && (detail.user_id === currentUserID ? <FileCards files={detail.artifacts} /> : <ul className="run-artifact-names">{detail.artifacts.map(file => <li key={file.id}>{file.name}</li>)}</ul>)}
        </> : detailTab === "tools" ? (detail.items.flatMap((item) => item.step ? [item.step] : []).length ? detail.user_id === currentUserID ? <StepList steps={detail.items.flatMap((item) => item.step ? [item.step] : [])} /> : <ReadOnlySteps steps={detail.items.flatMap((item) => item.step ? [item.step] : [])} /> : <div className="table-empty">{t("noToolCalls")}</div>) : detailTab === "requests" ? <RequestDiagnostics key={`${detail.run_id}:${detailRevision}`} runID={detail.run_id} /> : <dl className="run-data-facts">
          {[
            [t("users"), detail.display_name || detail.username], [t("provider"), detail.provider_name || "—"], [t("inputTokens"), formatTokens(detail.usage?.prompt_tokens)], [t("outputTokens"), formatTokens(detail.usage?.completion_tokens)], [t("cachedTokens"), formatTokens(detail.usage?.cached_tokens)], [t("totalDuration"), formatDuration(detail.duration_ms)], [t("update"), new Date(detail.updated_at).toLocaleString(getLocale(), { hour12: false })], [t("files"), String(detail.artifact_count)], [t("runID"), detail.run_id], [t("sessionID"), detail.session_id], [t("userID"), detail.user_id], ...(detail.resource ? [[t("resource"), detail.resource]] : []), ...(detail.archived ? [[t("version"), t("archivedVersion")]] : []),
          ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>}
      </div>}
    </Modal>}
  </>;
}
