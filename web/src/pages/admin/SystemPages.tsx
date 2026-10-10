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

const MarkdownContent = lazy(() => import("../../components/MarkdownContent"));

export function UsersPage() {
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
      setError(reason instanceof Error ? reason.message : "加载失败");
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
      setError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="admin-page-heading">
        <h2>用户</h2>
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
          添加用户
        </button>
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
              <span className="admin-user-role">{user.role === "admin" ? "管理员" : "用户"}</span>
              <span className={`admin-state${user.enabled !== false ? " is-enabled" : ""}`}>
                <i />{user.enabled !== false ? "已启用" : "已停用"}
              </span>
              <div className="admin-row-actions">
                <button className="icon-button" aria-label={`编辑用户 ${user.display_name || user.username}`}
                  title="编辑用户" onClick={() => setEditor({ ...user, password: "" })}>
                  <Pencil size={16} />
                </button>
                <button className="icon-button admin-delete-action" aria-label={`删除用户 ${user.display_name || user.username}`}
                  title="删除用户" onClick={() => setDeleting(user)}>
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
          title={editor.id ? "编辑用户" : "添加用户"}
          onClose={() => setEditor(null)}
          footer={
            <div className="modal-actions">
              <button
                type="submit"
                form="user-editor"
                className="primary-button"
                disabled={busy}
              >
                保存
              </button>
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
            <Field title="账号">
              <input
                required
                readOnly={Boolean(editor.id)}
                value={editor.username ?? ""}
                onChange={(event) =>
                  setEditor({ ...editor, username: event.target.value })
                }
              />
            </Field>
            <Field title="显示名称">
              <input
                value={editor.display_name ?? ""}
                onChange={(event) =>
                  setEditor({ ...editor, display_name: event.target.value })
                }
              />
            </Field>
            <Field title={editor.id ? "新密码" : "密码"}>
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
            <Field title="角色">
              <SelectField
                value={editor.role ?? "user"}
                options={[
                  { value: "user", label: "用户" },
                  { value: "admin", label: "管理员" },
                ]}
                onChange={(role) =>
                  setEditor({ ...editor, role: role as User["role"] })
                }
              />
            </Field>
            <Toggle
              title="启用"
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
          title="删除用户？"
          onClose={() => setDeleting(null)}
          size="small"
          footer={
            <div className="modal-actions">
              <button
                className="secondary-button"
                onClick={() => setDeleting(null)}
              >
                取消
              </button>
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
                删除
              </button>
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
  const [settings, setSettings] = useState<Record<string, unknown>>({});
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
  if (loading)
    return (
      <div className="panel-loading">
        <LoaderCircle className="spin" size={22} />
      </div>
    );
  return (
    <>
      <div className="admin-page-heading">
        <h2>系统</h2>
      </div>
      <ErrorNotice error={error} notice={notice} />
      <form
        className="admin-form system-form"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          void adminApi
            .saveSettings(settings)
            .then((value) => {
              setSettings(value);
              setNotice("已保存");
            })
            .catch((reason: Error) => setError(reason.message))
            .finally(() => setBusy(false));
        }}
      >
        <section className="settings-card">
          <h3>辅助模型</h3>
          {[
            {
              key: "compaction_model_id",
              title: "上下文压缩",
              kind: "chat",
              fallback: "使用主模型",
            },
            {
              key: "memory_model_id",
              title: "记忆提炼",
              kind: "chat",
              fallback: "使用主模型",
            },
            {
              key: "title_model_id",
              title: "对话标题",
              kind: "chat",
              fallback: "使用主模型",
            },
            {
              key: "image_model_id",
              title: "图像生成",
              kind: "image",
              fallback: "首个已启用的生图模型",
            },
            {
              key: "embedding_model_id",
              title: "记忆向量化",
              kind: "embedding",
              fallback: "本地 BGE small",
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
          <Field title="补充指令">
            <textarea
              rows={14}
              placeholder="可选"
              value={String(settings.system_prompt ?? "")}
              onChange={(event) =>
                setSettings({ ...settings, system_prompt: event.target.value })
              }
            />
          </Field>
          <Field title="工具轮次上限">
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
        <div className="form-footer">
          <button className="primary-button" disabled={busy}>
            {busy && <LoaderCircle className="spin" size={15} />}保存
          </button>
        </div>
      </form>
    </>
  );
}
export function WorkspacesPage() {
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
      setError(reason instanceof Error ? reason.message : "加载失败");
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
      setError(reason instanceof Error ? reason.message : "操作失败");
    } finally {
      setBusy("");
    }
  }
  return (
    <>
      <div className="admin-page-heading">
        <h2>工作区</h2>
        <button
          className="icon-button"
          aria-label="刷新"
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
                  {users.find((user) => user.id === item.user_id)
                    ?.display_name || item.user_id}
                </strong>
                <span>{item.image}</span>
                <small>{item.container}</small>
              </div>
              <span className={`admin-state${item.running ? " is-enabled" : ""}`}>
                <i />{item.running ? "运行中" : item.state || "未启动"}
              </span>
              <div className="workspace-row-actions">
                <button
                  className="secondary-button"
                  disabled={busy === item.user_id}
                  onClick={() =>
                    void action(item, item.running ? "stop" : "start")
                  }
                >
                  {item.running ? "停止" : "启动"}
                </button>
                <button className="secondary-button" disabled={busy === item.user_id}
                  onClick={() => setConfirm(item)}>重建</button>
              </div>
            </article>
          ))}
          {!items.length && <div className="empty-page">暂无工作区</div>}
        </div>
      )}
      {confirm && (
        <Modal
          className="ochi-admin-modal"
          title="重建工作区？"
          onClose={() => setConfirm(null)}
          size="small"
          footer={
            <div className="modal-actions">
              <button
                className="secondary-button"
                onClick={() => setConfirm(null)}
              >
                取消
              </button>
              <button
                className="primary-button"
                disabled={busy === confirm.user_id}
                onClick={() => void action(confirm, "rebuild")}
              >
                重建
              </button>
            </div>
          }
        >
          <p>
            {users.find((user) => user.id === confirm.user_id)?.display_name ||
              confirm.user_id}
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
  return tokens == null ? "—" : tokens.toLocaleString();
}
function RunStatusBadge({ run }: { run: Pick<AdminRun, "status" | "error"> }) {
  return <span className={`run-status run-status-${run.status}`} title={run.error || undefined}>
    <i />{statusLabel(run.status)}{run.error && <CircleAlert size={12} />}
  </span>;
}
function ReadOnlySteps({ steps }: { steps: Step[] }) {
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
      {result && <details className="technical-details"><summary>返回数据</summary><pre>{JSON.stringify(result, null, 2).slice(0, 64000)}</pre></details>}
    </details>;
  })}</div>;
}
const statusOptions = [
  { value: "", label: "所有状态" },
  ...["completed", "running", "queued", "waiting_user", "waiting_resource", "failed", "interrupted", "cancelled", "cancelling"].map(value => ({ value, label: statusLabel(value) })),
];
const dateOptions = [
  { value: "today", label: "今天" },
  { value: "7", label: "最近 7 天" },
  { value: "30", label: "最近 30 天" },
  { value: "90", label: "最近 90 天" },
];

export function RunsPage({ currentUserID, onNavigate }: { currentUserID: string; onNavigate: (path: string) => void }) {
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
      <h2>运行记录</h2>
      <div className="toolbar-actions">
        <SelectField label="统计范围" value={period} options={dateOptions} onChange={value => { setPeriod(value); setOffset(0); }} />
        <button className="icon-button" aria-label="刷新运行记录" disabled={loading} onClick={() => setRevision(value => value + 1)}>
          <RefreshCw size={16} className={loading ? "spin" : undefined} />
        </button>
      </div>
    </div>
    <ErrorNotice error={error} />
    <div className="run-view-tabs" role="tablist" aria-label="运行记录视图">
      {[{ id: "records", label: "记录" }, { id: "overview", label: "概览" }].map(tab =>
        <button key={tab.id} id={`run-tab-${tab.id}`} role="tab" aria-selected={view === tab.id} aria-controls="run-view" className={view === tab.id ? "selected" : ""} onClick={() => setView(tab.id)}>{tab.label}</button>,
      )}
      <span className="run-period-label">{stats ? `${new Date(stats.from).toLocaleDateString("zh-CN")} — ${new Date(stats.to).toLocaleDateString("zh-CN")}` : ""}</span>
    </div>
    <div className={`run-summary-strip ${loading ? "is-updating" : ""}`} data-view={view} aria-busy={loading}>
      <div><span>运行</span><strong>{stats?.runs.toLocaleString() ?? "—"}</strong><small>{stats ? `${stats.completed} 完成 · ${stats.active} 进行中` : ""}</small></div>
      <div><span>异常</span><strong className={stats && stats.failed + stats.interrupted ? "danger" : ""}>{stats ? (stats.failed + stats.interrupted).toLocaleString() : "—"}</strong><small>{stats ? `${stats.failed} 失败 · ${stats.interrupted} 中断` : ""}</small></div>
      <div><span>输入 Tokens</span><strong>{stats?.usage_reported_runs ? formatTokens(stats.prompt_tokens) : "—"}</strong><small>{stats?.usage_reported_runs ? `${stats.usage_reported_runs} 条有用量` : ""}</small></div>
      <div><span>输出 Tokens</span><strong>{stats?.usage_reported_runs ? formatTokens(stats.completion_tokens) : "—"}</strong><small>{stats?.usage_reported_runs ? `${formatTokens(stats.total_tokens)} 总量` : ""}</small></div>
      <div><span>缓存 Tokens</span><strong>{formatTokens(stats?.cached_tokens)}</strong></div>
      <div><span>平均总耗时</span><strong>{formatDuration(stats?.average_duration_ms)}</strong><small>{stats ? `${stats.cancelled} 已停止` : ""}</small></div>
    </div>
    <div className="runs-filterbar">
      <label className="search-input"><Search size={15} /><input aria-label="搜索运行记录" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索任务、模型、用户" /></label>
      <SelectField label="运行状态" value={status} options={statusOptions} onChange={value => { setStatus(value); setOffset(0); }} />
      <SelectField label="筛选模型" value={model} options={[{ value: "", label: "所有模型" }, ...models.map(item => ({ value: item.id, label: item.name }))]} onChange={value => { setModel(value); setOffset(0); }} />
      <SelectField label="筛选用户" value={account} options={[{ value: "", label: "所有用户" }, ...users.map(item => ({ value: item.id, label: item.display_name || item.username }))]} onChange={value => { setAccount(value); setOffset(0); }} />
    </div>
    <section id="run-view" role="tabpanel" aria-labelledby={`run-tab-${view}`}>
    {view === "records" ? <>
      <div className={`admin-table-wrap runs-table-wrap ${loading ? "is-updating" : ""}`} aria-busy={loading}>
        <table className="admin-table runs-table">
          <thead><tr><th>任务 / 用户</th><th>模型</th><th>状态</th><th className="numeric">耗时</th><th className="numeric">Tokens</th><th>开始</th><th><span className="sr-only">详情</span></th></tr></thead>
          <tbody>{page?.items.map(run => <tr key={run.run_id}>
            <td className="runs-cell-task"><button className="run-task-link" onClick={() => selectRun(run)} title={run.prompt || run.session_title}>
              <strong>{run.prompt || run.session_title}</strong>
              <small className="run-task-user" title={run.username}>{run.display_name || run.username || "—"}{run.prompt && run.prompt !== run.session_title ? ` · ${run.session_title}` : ""}</small>
            </button></td>
            <td className="runs-cell-model" title={[run.model_name, run.provider_name, run.effort].filter(Boolean).join(" · ")}><span className="table-model-name" title={run.model_name}>{run.model_name || "—"}</span><small className="table-secondary">{[run.provider_name, run.effort].filter(Boolean).join(" · ")}</small></td>
            <td className="runs-cell-status"><RunStatusBadge run={run} /></td>
            <td className="numeric runs-cell-duration" data-label="耗时">{formatDuration(run.duration_ms)}</td>
            <td className="numeric runs-cell-tokens" data-label="Tokens"
              title={`输入 ${formatTokens(run.usage?.prompt_tokens)} · 输出 ${formatTokens(run.usage?.completion_tokens)} · 缓存 ${formatTokens(run.usage?.cached_tokens)}`}>
              {run.usage?.total_tokens ? formatTokens(run.usage.total_tokens) : "—"}
              <small className="table-secondary">{run.step_count} 次工具</small>
            </td>
            <td className="table-date runs-cell-time" title={new Date(run.created_at).toLocaleString("zh-CN")}>
              <span>{new Date(run.created_at).toLocaleDateString("zh-CN", { month: "short", day: "numeric" })}</span>
              <small>{new Date(run.created_at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}</small>
              <span className="run-responsive-user" title={[run.username, run.session_title].filter(Boolean).join(" · ")}>{run.display_name || run.username || "—"}{run.prompt && run.prompt !== run.session_title ? ` · ${run.session_title}` : ""}</span>
            </td>
            <td className="runs-cell-action"><button className="icon-button" aria-label={`查看运行 ${run.prompt || run.session_title}`} title="运行详情" onClick={() => selectRun(run)}><ArrowUpRight size={16} /></button></td>
          </tr>)}</tbody>
        </table>
        {!page?.items.length && <div className="table-empty">{loading ? <LoaderCircle className="spin" size={18} /> : "暂无记录"}</div>}
      </div>
      <div className="table-pagination">
        <span>{page ? `${page.total.toLocaleString()} 条 · ${page.total ? Math.min(offset + 1, page.total) : 0}–${Math.min(offset + limit, page.total)}` : ""}</span>
        <div><button className="icon-button" aria-label="上一页运行记录" disabled={loading || offset === 0} onClick={() => setOffset(value => Math.max(0, value - limit))}><ChevronLeft size={16} /></button><span>{Math.floor(offset / limit) + 1} / {Math.max(1, Math.ceil((page?.total ?? 0) / limit))}</span><button className="icon-button" aria-label="下一页运行记录" disabled={loading || !page || offset + limit >= page.total} onClick={() => setOffset(value => value + limit)}><ChevronRight size={16} /></button></div>
      </div>
    </> : <div className="admin-table-wrap" aria-busy={loading}>
      <table className="admin-table usage-model-table"><thead><tr><th>模型 / 服务</th><th className="numeric">运行</th><th className="numeric">异常</th><th className="numeric">Tokens</th><th className="numeric">缓存</th></tr></thead>
        <tbody>{stats?.models.map(item => <tr key={`${item.model_id}:${item.model_name}`}>
          <td className="usage-cell-name"><strong>{item.model_name || "—"}</strong><small className="table-secondary">{item.provider_name || "—"}</small></td>
          <td className="numeric" data-label="运行">{formatTokens(item.runs)}</td>
          <td className={`numeric ${item.failed ? "danger" : ""}`} data-label="异常">{item.failed}</td>
          <td className="numeric" data-label="Tokens" title={`输入 ${formatTokens(item.prompt_tokens)} · 输出 ${formatTokens(item.completion_tokens)}`}>{item.total_tokens ? formatTokens(item.total_tokens) : "—"}</td>
          <td className="numeric" data-label="缓存">{formatTokens(item.cached_tokens)}</td>
        </tr>)}</tbody>
      </table>{!stats?.models.length && <div className="table-empty">{loading ? <LoaderCircle className="spin" size={18} /> : "暂无记录"}</div>}
    </div>}
    </section>
    {selected && current && <Modal className="ochi-admin-modal" title="运行详情" size="large" onClose={() => setSelected(null)} footer={<div className="modal-actions">
      {current.user_id === currentUserID && <button className="secondary-button" onClick={() => onNavigate(`/c/${current.session_id}`)}>打开对话<ArrowUpRight size={14} /></button>}
      <button className="secondary-button" disabled={detailLoading} onClick={() => setDetailRevision(value => value + 1)}><RefreshCw size={14} className={detailLoading ? "spin" : undefined} />刷新</button>
    </div>}>
      <div className="run-detail-heading"><strong>{current.session_title}</strong><RunStatusBadge run={current} /></div>
      <div className="run-detail-meta"><span>{current.display_name || current.username}</span><span>{current.model_name}{current.effort ? ` · ${current.effort}` : ""}</span><span>{new Date(current.created_at).toLocaleString("zh-CN", { hour12: false })}</span><span>{formatDuration(current.duration_ms)}</span></div>
      <div className="run-detail-tabs" role="tablist" aria-label="运行详情">
        {[{ id: "result", title: "内容" }, { id: "tools", title: `工具 (${current.step_count})` }, { id: "metadata", title: "数据" }].map(tab => <button key={tab.id} role="tab" aria-selected={detailTab === tab.id} aria-controls="run-detail-content" className={detailTab === tab.id ? "selected" : ""} onClick={() => setDetailTab(tab.id)}>{tab.title}</button>)}
      </div>
      <ErrorNotice error={detailError} />
      {detailLoading ? <div className="run-detail-loading"><LoaderCircle size={18} className="spin" /></div> : detail && <div id="run-detail-content" role="tabpanel" className="run-detail-content">
        {detailTab === "result" ? <>
          <div className="run-prompt-text">{detail.prompt}</div>
          {detail.error && <pre className="run-error-output">{detail.error}</pre>}
          {detail.output && <div className="markdown-body"><Suspense fallback={<div>{detail.output}</div>}><MarkdownContent content={detail.output} isStreaming={false} /></Suspense></div>}
          {detail.artifacts.length > 0 && (detail.user_id === currentUserID ? <FileCards files={detail.artifacts} /> : <ul className="run-artifact-names">{detail.artifacts.map(file => <li key={file.id}>{file.name}</li>)}</ul>)}
        </> : detailTab === "tools" ? (detail.steps.length ? detail.user_id === currentUserID ? <StepList steps={detail.steps} /> : <ReadOnlySteps steps={detail.steps} /> : <div className="table-empty">无工具调用</div>) : <dl className="run-data-facts">
          {[
            ["用户", detail.display_name || detail.username], ["服务", detail.provider_name || "—"], ["输入 Tokens", formatTokens(detail.usage?.prompt_tokens)], ["输出 Tokens", formatTokens(detail.usage?.completion_tokens)], ["缓存 Tokens", formatTokens(detail.usage?.cached_tokens)], ["总耗时", formatDuration(detail.duration_ms)], ["更新", new Date(detail.updated_at).toLocaleString("zh-CN", { hour12: false })], ["文件", String(detail.artifact_count)], ["运行 ID", detail.run_id], ["对话 ID", detail.session_id], ["用户 ID", detail.user_id], ...(detail.resource ? [["资源", detail.resource]] : []), ...(detail.archived ? [["版本", "历史版本"]] : []),
          ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>}
      </div>}
    </Modal>}
  </>;
}
