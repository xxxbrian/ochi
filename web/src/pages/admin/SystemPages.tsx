import { publicReply } from "../../../../shared/conversation/projection";
import { t, useAdminI18n, getLocale, translateError } from "./i18n";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  ArrowUpRight,
  Ban,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  CircleStop,
  CircleX,
  Clock,
  Container,
  Ellipsis,
  History,
  Pencil,
  CirclePlay,
  Play,
  RefreshCw,
  RotateCw,
  Search,
  Trash2,
  TriangleAlert,
  UserPlus,
  Wrench,
} from "lucide-react";
import { adminApi } from "../../lib/api";
import type { AdminRun, AdminRunDetail, AdminRunFilter, AdminRunPage, AdminRunStats, Model, Step, User, Workspace } from "../../lib/types";
import { Modal } from "../../components/Modal";
import { SelectField } from "../../components/ui/Select";
import { ActionMenu, MenuAction } from "../../components/ui/Menu";
import { statusLabel } from "../../lib/router";
import { AdminSkeleton, confirmMatches, ErrorNotice, Field, Toggle, TypedConfirm } from "./Fields";
import { StepList } from "../../components/ProcessSteps";
import { FileCards } from "../../components/FileCards";
import { RequestDiagnostics } from "./RequestDiagnostics";
import { UpdateCard } from "./UpdateCard";
import { AdminHeader, Card, CardHead, Checkbox, Collapse, Drawer, Empty, MenuSelect, Pill, Seg, SkeletonRows, StatusDot, Stat, Who, type Tone } from "./ui";

const MarkdownContent = lazy(() => import("../../components/MarkdownContent"));

export function UsersPage({ currentUserID }: { currentUserID: string }) {
  useAdminI18n();
  const [users, setUsers] = useState<User[]>([]);
  const [editor, setEditor] = useState<
    (Partial<User> & { password?: string }) | null
  >(null);
  const [deleting, setDeleting] = useState<User | null>(null);
  const [typed, setTyped] = useState("");
  useEffect(() => setTyped(""), [deleting]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | "admin" | "user">("all");
  const [selected, setSelected] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<"name" | "role" | "status">("name");
  const visibleUsers = useMemo(() => {
    const q = query.trim().toLowerCase();
    return users.filter(
      (u) =>
        (roleFilter === "all" || u.role === roleFilter) &&
        (!q || `${u.display_name || ""} ${u.username}`.toLowerCase().includes(q)),
    );
  }, [users, query, roleFilter]);
  async function bulkEnable(enabled: boolean) {
    setBusy(true);
    try {
      for (const u of users.filter((x) => selected.includes(x.id))) {
        await adminApi.save<User>("users", { id: u.id, username: u.username, display_name: u.display_name, role: u.role, enabled }, true);
      }
      setSelected([]);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("saveFailed"));
    } finally {
      setBusy(false);
    }
  }
  async function setUserEnabled(user: User, enabled: boolean) {
    setBusy(true);
    setError("");
    try {
      await adminApi.save<User>("users", { id: user.id, username: user.username, display_name: user.display_name, role: user.role, enabled }, true);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("saveFailed"));
    } finally {
      setBusy(false);
    }
  }
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
  async function removeUser() {
    if (!deleting || busy) return;
    setBusy(true);
    setError("");
    setDeleteError("");
    try {
      await adminApi.remove("users", deleting.id);
      setDeleting(null);
      await refresh();
    } catch (reason) {
      setDeleteError(reason instanceof Error ? reason.message : t("operationFailed"));
    } finally {
      setBusy(false);
    }
  }
  const PAGE = 10;
  const sorted = useMemo(() => [...visibleUsers].sort((x, y) => {
    if (sort === "role") return x.role.localeCompare(y.role) || (x.display_name || x.username).localeCompare(y.display_name || y.username);
    if (sort === "status") return Number(y.enabled !== false) - Number(x.enabled !== false);
    return (x.display_name || x.username).localeCompare(y.display_name || y.username, getLocale());
  }), [visibleUsers, sort]);
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE));
  const pageIndex = Math.min(page, pages - 1);
  const rows = sorted.slice(pageIndex * PAGE, pageIndex * PAGE + PAGE);
  const rowIDs = rows.filter((u) => u.id !== currentUserID).map((u) => u.id);
  const pageSelected = rowIDs.length > 0 && rowIDs.every((id) => selected.includes(id));
  const toggle = (id: string) => setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const roleLabel = (role: string) => (role === "admin" ? t("administrator") : t("userRole"));
  const filtered = query.trim() !== "" || roleFilter !== "all";
  return (
    <>
      <AdminHeader
        actions={<button className="btn primary" onClick={() => setEditor({ username: "", display_name: "", role: "user", enabled: true, password: "" })}><UserPlus className="ic" />{t("addUser")}</button>}
        toolbar={<>
          <div className="search-field"><Search className="ic" /><input className="input" type="search" value={query} placeholder={t("adminSearchUsers")} aria-label={t("adminSearchUsers")}
            onChange={(event) => { setQuery(event.target.value); setPage(0); }} /></div>
          <Seg small label={t("adminColRole")} value={roleFilter} onChange={(next) => { setRoleFilter(next); setPage(0); }}
            options={[{ v: "all", l: t("adminAllRoles") }, { v: "admin", l: t("administrator") }, { v: "user", l: t("userRole") }]} />
          <span className="grow" />
          <MenuSelect label={t("sortBy")} value={sort} onChange={setSort}
            options={[{ v: "name", l: t("sortName") }, { v: "role", l: t("adminColRole") }, { v: "status", l: t("adminColStatus") }]} />
        </>} />
      <ErrorNotice error={error} />
      <Card flush>
        {loading ? <SkeletonRows rows={5} /> : <>
          <Collapse open={selected.length > 0} className="ochi-admin-bulk-c">
            <div className="ochi-admin-bulk" role="toolbar">
              <b className="tnum">{t("adminSelectedCount", { count: selected.length })}</b><span className="grow" />
              <button className="btn sm secondary" disabled={busy} onClick={() => void bulkEnable(true)}><Check className="ic" />{t("adminBulkEnable")}</button>
              <button className="btn sm secondary" disabled={busy} onClick={() => void bulkEnable(false)}><Ban className="ic" />{t("adminBulkDisable")}</button>
              <button className="btn sm ghost" onClick={() => setSelected([])}>{t("adminClearSelection")}</button>
            </div>
          </Collapse>
          {rows.length ? <>
            <div className="ochi-admin-tscroll"><table className="ochi-admin-table ochi-admin-users">
              <thead><tr>
                <th className="c"><Checkbox checked={pageSelected} label={t("adminSelectAll")} onChange={() => setSelected((cur) => pageSelected ? cur.filter((id) => !rowIDs.includes(id)) : [...new Set([...cur, ...rowIDs])])} /></th>
                <th>{t("adminColUser")}</th><th className="ochi-admin-hide-s">{t("adminColRole")}</th><th className="ochi-admin-hide-s">{t("adminColStatus")}</th><th className="c" />
              </tr></thead>
              <tbody>{rows.map((user, index) => {
                const name = user.display_name || user.username;
                const picked = selected.includes(user.id);
                return (
                  <tr key={user.id} data-sel={picked} style={{ "--i": index } as CSSProperties}>
                    <td className="c"><Checkbox checked={picked} label={t("adminSelectUser", { name })} onChange={() => { if (user.id !== currentUserID) toggle(user.id); }} /></td>
                    <td><Who name={name} sub={user.username} /></td>
                    <td className="ochi-admin-hide-s"><Pill tone={user.role === "admin" ? "accent" : "neutral"}>{roleLabel(user.role)}</Pill></td>
                    <td className="ochi-admin-hide-s"><StatusDot tone={user.enabled !== false ? "success" : ""}>{user.enabled !== false ? t("enabled") : t("disabled")}</StatusDot></td>
                    <td className="c">
                      <ActionMenu trigger={<Ellipsis className="ic" />} label={t("editUserNamed", { name })} className="icon-btn sm">
                        <MenuAction onClick={() => setEditor({ ...user, password: "" })}><Pencil className="ic" />{t("editUser")}</MenuAction>
                        <MenuAction disabled={user.id === currentUserID} onClick={() => void setUserEnabled(user, user.enabled === false)}>
                          {user.enabled === false ? <Check className="ic" /> : <Ban className="ic" />}{user.enabled === false ? t("adminBulkEnable") : t("adminBulkDisable")}</MenuAction>
                        <MenuAction danger disabled={user.id === currentUserID} onClick={() => { setDeleteError(""); setDeleting(user); }}><Trash2 className="ic" />{user.id === currentUserID ? t("cannotDeleteCurrentUser") : t("deleteUser")}</MenuAction>
                      </ActionMenu>
                    </td>
                  </tr>
                );
              })}</tbody>
            </table></div>
            <footer className="ochi-admin-pager">
              <span className="muted tnum">{t("recordsRange", { total: sorted.length, start: pageIndex * PAGE + 1, end: pageIndex * PAGE + rows.length })}</span><span className="grow" />
              <button className="icon-btn sm" aria-label={t("previousRunsPage")} disabled={pageIndex === 0} onClick={() => setPage(pageIndex - 1)}><ChevronLeft className="ic" /></button>
              {Array.from({ length: pages }, (_, i) => <button key={i} className="ochi-admin-pg" aria-current={i === pageIndex} onClick={() => setPage(i)}>{i + 1}</button>)}
              <button className="icon-btn sm" aria-label={t("nextRunsPage")} disabled={pageIndex >= pages - 1} onClick={() => setPage(pageIndex + 1)}><ChevronRight className="ic" /></button>
            </footer>
          </> : <Empty icon={<Search className="ic" />} title={t("adminNoUsersMatch")} desc={t("adminNoUsersMatchHint")}
            action={filtered ? <button className="btn secondary sm" onClick={() => { setQuery(""); setRoleFilter("all"); setPage(0); }}>{t("clearFilters")}</button> : undefined} />}
        </>}
      </Card>
      {editor && (
        <Drawer title={editor.id ? t("editUser") : t("addUser")} sub={editor.id ? editor.username : undefined} onClose={() => { if (!busy) setEditor(null); }}
          footer={<footer className="ochi-admin-df"><span className="grow" />
            <button type="button" className="btn ghost" disabled={busy} onClick={() => setEditor(null)}>{t("cancel")}</button>
            <button type="submit" form="user-editor" className={`btn primary${busy ? " btn-progress" : ""}`} disabled={busy}>{busy ? t("savingEllipsis") : t("save")}</button></footer>}>
          <form id="user-editor" className="ochi-admin-stack-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <Field title={t("account")}>
              <input className="input mono" required readOnly={Boolean(editor.id)} autoComplete="off" value={editor.username ?? ""} onChange={(event) => setEditor({ ...editor, username: event.target.value })} />
            </Field>
            <Field title={t("displayName")}>
              <input className="input" value={editor.display_name ?? ""} onChange={(event) => setEditor({ ...editor, display_name: event.target.value })} />
            </Field>
            <Field title={editor.id ? t("newPassword") : t("password")}>
              <input className="input" type="password" required={!editor.id} value={editor.password ?? ""} autoComplete="new-password" onChange={(event) => setEditor({ ...editor, password: event.target.value })} />
            </Field>
            <div className="ochi-admin-field"><span className="field-label">{t("role")}</span>
              <Seg value={(editor.role ?? "user") as "user" | "admin"} onChange={(role) => setEditor({ ...editor, role })} options={[{ v: "user", l: t("userRole") }, { v: "admin", l: t("administrator") }]} /></div>
            <Toggle title={t("enable")} value={editor.enabled ?? true} onChange={(enabled) => setEditor({ ...editor, enabled })} />
            <ErrorNotice error={error} />
          </form>
        </Drawer>
      )}
      {deleting && (
        <Modal title={t("deleteUserQuestion")} onClose={() => setDeleting(null)} dismissible={!busy} size="small" className="ochi-admin-danger-m"
          footer={<div className="modal-actions">
            <button className="btn ghost" disabled={busy} onClick={() => setDeleting(null)}>{t("cancel")}</button>
            <button className={`btn danger${busy ? " btn-progress" : ""}`} disabled={busy || !confirmMatches(typed, deleting.username)} aria-busy={busy} onClick={() => void removeUser()}>
              {busy ? t("deletingEllipsis") : t("delete")}</button>
          </div>}>
          <p><b>{deleting.display_name || deleting.username}</b></p>
          <div className="ochi-admin-alert"><TriangleAlert className="ic" /><div>{t("deleteUserDescription")}</div></div>
          <TypedConfirm name={deleting.username} value={typed} onChange={setTyped} disabled={busy} />
          <ErrorNotice error={deleteError} />
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
      <AdminSkeleton />
    );
  return (
    <>
      <AdminHeader actions={<button type="submit" form="system-settings" className={`btn primary${busy ? " btn-progress" : ""}`} disabled={busy || debugBusy}>
        <Check className="ic" />{busy ? t("savingEllipsis") : t("save")}</button>} />
      <ErrorNotice error={error} notice={notice} />
      <UpdateCard />
      <form
        id="system-settings"
        className="ochi-admin-stack-form"
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
        <Card>
          <CardHead title={t("auxiliaryModels")} />
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
        </Card>
        <Card>
          <CardHead title={"Agent"} />
          <Field title={t("additionalInstructions")}>
            <textarea
              className="textarea"
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
              className="input"
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
        </Card>
        <Card>
          <CardHead title={t("diagnostics")} />
          <Toggle
            title={t("debugMode")}
            value={debugMode}
            disabled={busy || debugBusy}
            onChange={(debug_mode) => void saveDebugMode(debug_mode)}
          />
          <p className="field-hint">
            {t("debugModeHint")}{debugBusy ? t("savingEllipsis") : t("debugImmediateHint")}{t("debugHistoryHint")}</p>
        </Card>
      </form>
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
  const [confirm, setConfirm] = useState<{
    workspace: Workspace;
    action: "rebuild" | "delete";
  } | null>(null);
  const [confirmError, setConfirmError] = useState("");
  const [typed, setTyped] = useState("");
  useEffect(() => setTyped(""), [confirm]);
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
    if (busy) return;
    setBusy(item.user_id);
    setError("");
    setConfirmError("");
    try {
      if (name === "delete") {
        await adminApi.remove("workspaces", item.user_id);
      } else {
        await adminApi.workspace(item.user_id, name);
      }
      setConfirm(null);
      await refresh();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : t("operationFailed");
      if (name === "rebuild" || name === "delete") setConfirmError(message);
      else setError(message);
    } finally {
      setBusy("");
    }
  }
  function workspaceName(item: Workspace) {
    return item.kind === "control"
      ? t("pluginControlWorkspace")
      : users.find((user) => user.id === item.user_id)?.display_name || item.user_id;
  }
  const running = items.filter((item) => item.running).length;
  const outdated = items.filter((item) => item.update_available).length;
  return (
    <>
      <AdminHeader actions={<button className="btn secondary" disabled={loading} onClick={() => { setLoading(true); void refresh(); }}><RefreshCw className={`ic${loading ? " ic-turn" : ""}`} />{t("refresh")}</button>} />
      <ErrorNotice error={error} />
      {loading ? (
        <Card flush><SkeletonRows rows={3} /></Card>
      ) : items.length ? <>
        <div className="ochi-admin-stats">
          <Stat label={t("running")} value={`${running} / ${items.length}`} sub={t("workspaceContainers")} tone={running ? "success" : undefined} />
          <Stat label={t("workspaceImageUpdateAvailable")} value={outdated} sub={t("workspaceRebuildToApply")} tone={outdated ? "warn" : undefined} />
        </div>
        <div className="ochi-admin-wsgrid">
          {items.map((item) => {
            const state = item.running ? "running" : !item.state || item.state === "not_created" ? "stopped" : item.state === "error" || item.state === "dead" ? "error" : "stopped";
            const pending = busy === item.user_id;
            const name = workspaceName(item);
            return (
              <Card key={item.user_id} className="ochi-admin-ws" data-st={pending ? "pending" : state}>
                <div className="ochi-admin-ws-h">
                  <Who name={name} sub={item.container} mono />
                  <span className="grow" />
                  {pending ? <Pill tone="warn"><i className="dot-live" aria-hidden="true" />{t("working")}</Pill>
                    : <Pill tone={state === "running" ? "success" : state === "error" ? "danger" : "neutral"}><i className="dot" data-tone={state === "running" ? "success" : state === "error" ? "danger" : ""} />
                      {item.running ? t("running") : !item.state || item.state === "not_created" ? t("notStarted") : item.state}</Pill>}
                </div>
                {item.kind === "control" && <p className="muted ochi-admin-ws-note">{t("pluginControlDescription")}</p>}
                <div className="ochi-admin-ws-meta">
                  <span className="mono" title={item.image}><Container className="ic" />{item.image}</span>
                  {item.update_available ? <Pill tone="warn">{t("workspaceImageUpdateAvailable")}</Pill> : null}
                </div>
                <div className="ochi-admin-ws-act">
                  <button className="btn sm secondary" disabled={Boolean(busy)} onClick={() => void action(item, item.running ? "stop" : "start")}>
                    {item.running ? <CircleStop className="ic" /> : <Play className="ic" />}{item.running ? t("stop") : t("startAction")}</button>
                  <button className="btn sm secondary" disabled={Boolean(busy)} onClick={() => { setConfirmError(""); setConfirm({ workspace: item, action: "rebuild" }); }}>
                    <RotateCw className="ic" />{t("rebuild")}</button>
                  <span className="grow" />
                  {item.kind !== "control" && (
                    <button className="btn sm danger-ghost" aria-label={t("deleteWorkspaceNamed", { name })} title={t("deleteWorkspace")} disabled={Boolean(busy)}
                      onClick={() => { setConfirmError(""); setConfirm({ workspace: item, action: "delete" }); }}><Trash2 className="ic" />{t("delete")}</button>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      </> : !error && <Card><Empty icon={<Container className="ic" />} title={t("noWorkspaces")} /></Card>}
      {confirm && (
        <Modal
          className={confirm.action === "delete" ? "ochi-admin-danger-m" : ""}
          title={confirm.action === "delete" ? t("deleteWorkspaceQuestion") : t("rebuildWorkspaceQuestion")}
          onClose={() => setConfirm(null)}
          dismissible={!busy}
          size="small"
          footer={
            <div className="modal-actions">
              <button
                className="btn secondary"
                disabled={Boolean(busy)}
                onClick={() => setConfirm(null)}
              >
                {t("cancel")}</button>
              <button
                className={`${confirm.action === "delete" ? "btn danger" : "btn primary"}${busy ? " btn-progress" : ""}`}
                disabled={Boolean(busy) || (confirm.action === "delete" && !confirmMatches(typed, workspaceName(confirm.workspace)))}
                aria-busy={Boolean(busy)}
                onClick={() => void action(confirm.workspace, confirm.action)}
              >
                {confirm.action === "delete"
                  ? busy ? t("deletingEllipsis") : t("delete")
                  : busy ? t("rebuildingEllipsis") : t("rebuild")}</button>
            </div>
          }
        >
          <p>
            {workspaceName(confirm.workspace)}
          </p>
          {confirm.action === "delete" && <>
            <div className="ochi-admin-alert"><TriangleAlert className="ic" /><div>{t("deleteWorkspaceDescription")}</div></div>
            <TypedConfirm name={workspaceName(confirm.workspace)} value={typed} onChange={setTyped} disabled={Boolean(busy)} />
          </>}
          <ErrorNotice error={confirmError} />
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
function runTone(status: string): Tone {
  return status === "completed" ? "success" : status === "failed" || status === "interrupted" ? "danger"
    : status === "cancelled" || status === "cancelling" ? "neutral" : status === "waiting_user" || status === "waiting_resource" ? "warn" : "accent";
}
function RunStatusBadge({ run }: { run: Pick<AdminRun, "status" | "error" | "error_code"> }) {
  useAdminI18n();
  const error = translateError(run.error_code) ?? run.error;
  return <Pill tone={runTone(run.status)}>{statusLabel(run.status)}{error && <CircleAlert className="ic" />}</Pill>;
}
function RunStatusIcon({ status }: { status: string }) {
  const tone = runTone(status);
  const Icon = tone === "success" ? CircleCheck : tone === "danger" ? CircleX : tone === "warn" ? Clock : tone === "accent" ? CirclePlay : CircleSlash;
  return <span className="ochi-admin-sic" data-tone={tone === "neutral" ? "" : tone}><Icon className={`ic${tone === "accent" ? " ic-pulse" : ""}`} /></span>;
}
function ago(value: string) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60000));
  const rtf = new Intl.RelativeTimeFormat(getLocale(), { numeric: "auto" });
  if (minutes < 60) return rtf.format(-minutes, "minute");
  if (minutes < 1440) return rtf.format(-Math.round(minutes / 60), "hour");
  return rtf.format(-Math.round(minutes / 1440), "day");
}
function ReadOnlySteps({ steps }: { steps: Step[] }) {
  useAdminI18n();
  return <div className="ochi-admin-ro-steps">{steps.map(step => {
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
  const rows = page?.items ?? [];
  const usage = stats?.models ?? [];
  const failures = stats ? stats.failed + stats.interrupted : 0;
  const rate = stats && stats.runs ? Math.round(((stats.runs - failures) / stats.runs) * 1000) / 10 : null;
  return <>
    <AdminHeader
      actions={<button className="btn secondary" aria-label={t("refreshRuns")} disabled={loading} onClick={() => setRevision(value => value + 1)}><RefreshCw className={`ic${loading ? " ic-turn" : ""}`} />{t("refresh")}</button>}
      toolbar={<>
        <div className="search-field"><Search className="ic" /><input className="input" type="search" aria-label={t("searchRuns")} value={query} onChange={event => setQuery(event.target.value)} placeholder={t("searchRunsPlaceholder")} /></div>
        <MenuSelect label={t("runStatus")} value={status} options={statusOptions().map(o => ({ v: o.value, l: o.label }))} onChange={value => { setStatus(value); setOffset(0); }} />
        <MenuSelect label={t("filterModel")} value={model} options={[{ v: "", l: t("allModels") }, ...models.map(item => ({ v: item.id, l: item.name }))]} onChange={value => { setModel(value); setOffset(0); }} />
        <MenuSelect label={t("filterUser")} value={account} options={[{ v: "", l: t("allUsers") }, ...users.map(item => ({ v: item.id, l: item.display_name || item.username }))]} onChange={value => { setAccount(value); setOffset(0); }} />
        <span className="grow" />
        <Seg small label={t("statisticsRange")} value={period} onChange={value => { setPeriod(value); setOffset(0); }} options={dateOptions().map(o => ({ v: o.value, l: o.label }))} />
      </>} />
    <ErrorNotice error={error} />
    <div className="ochi-admin-stats" aria-busy={loading}>
      <Stat label={t("runs")} value={stats?.runs.toLocaleString(getLocale()) ?? "—"} sub={stats ? t("runsCompletedActive", { completed: stats.completed, active: stats.active }) : undefined} />
      <Stat label={t("successRate")} value={rate == null ? "—" : `${rate}%`} sub={stats ? t("runsFailedInterrupted", { failed: stats.failed, interrupted: stats.interrupted }) : undefined} tone={rate != null && rate >= 95 ? "success" : rate != null ? "warn" : undefined} />
      <Stat label={t("averageDuration")} value={formatDuration(stats?.average_duration_ms)} sub={stats ? t("cancelledCount", { count: stats.cancelled }) : undefined} />
      <Stat label={t("tokenUsage")} value={stats?.usage_reported_runs ? formatTokens(stats.total_tokens) : "—"} sub={stats?.usage_reported_runs ? `${t("inputTokens")} ${formatTokens(stats.prompt_tokens)} · ${t("outputTokens")} ${formatTokens(stats.completion_tokens)}` : undefined} />
    </div>
    {usage.length > 0 && <Card flush>
      <div className="ochi-admin-tscroll"><table className="ochi-admin-table usage-model-table"><thead><tr><th>{t("modelProvider")}</th><th className="r">{t("runs")}</th><th className="r">{t("issues")}</th><th className="r">Tokens</th><th className="r ochi-admin-hide-s">{t("cache")}</th></tr></thead>
        <tbody>{usage.map(item => <tr key={`${item.model_id}:${item.model_name}`}>
          <td><b>{item.model_name || "—"}</b><br /><small>{item.provider_name || "—"}</small></td>
          <td className="r tnum">{formatTokens(item.runs)}</td>
          <td className="r tnum" style={item.failed ? { color: "var(--danger)" } : undefined}>{item.failed}</td>
          <td className="r tnum" title={t("inputOutputSummary", { input: formatTokens(item.prompt_tokens), output: formatTokens(item.completion_tokens) })}>{item.total_tokens ? formatTokens(item.total_tokens) : "—"}</td>
          <td className="r tnum ochi-admin-hide-s">{formatTokens(item.cached_tokens)}</td>
        </tr>)}</tbody>
      </table></div>
    </Card>}
    <Card flush aria-busy={loading}>
      {loading && !rows.length ? <SkeletonRows rows={6} /> : rows.length ? <>
        <div className="ochi-admin-runs">{rows.map((run, index) => (
          <button type="button" className="ochi-admin-run" key={run.run_id} style={{ "--i": Math.min(index, 12) } as CSSProperties} onClick={() => selectRun(run)}
            aria-label={t("viewRunNamed", { name: run.prompt || run.session_title })}>
            <RunStatusIcon status={run.status} />
            <div className="ochi-admin-run-t"><b>{run.prompt || run.session_title || t("newChat")}</b><small>{[run.model_name, run.display_name || run.username].filter(Boolean).join(" · ")}</small></div>
            <span className="ochi-admin-run-m tnum ochi-admin-hide-s" title={t("usageSummary", { input: formatTokens(run.usage?.prompt_tokens), output: formatTokens(run.usage?.completion_tokens), cached: formatTokens(run.usage?.cached_tokens) })}>
              {run.usage?.total_tokens ? formatTokens(run.usage.total_tokens) : "—"}</span>
            <span className="ochi-admin-run-m tnum ochi-admin-hide-s"><Wrench className="ic" />{run.step_count}</span>
            <span className="ochi-admin-run-m tnum">{formatDuration(run.duration_ms)}</span>
            <span className="ochi-admin-run-ago muted ochi-admin-hide-s" title={new Date(run.created_at).toLocaleString(getLocale())}>{ago(run.created_at)}</span>
            <ChevronRight className="ic ochi-admin-go" />
          </button>
        ))}</div>
        <footer className="ochi-admin-pager">
          <span className="muted tnum">{page ? t("recordsRange", { total: page.total, start: page.total ? Math.min(offset + 1, page.total) : 0, end: Math.min(offset + limit, page.total) }) : ""}</span><span className="grow" />
          <button className="icon-btn sm" aria-label={t("previousRunsPage")} disabled={loading || offset === 0} onClick={() => setOffset(value => Math.max(0, value - limit))}><ChevronLeft className="ic" /></button>
          <span className="tnum muted">{Math.floor(offset / limit) + 1} / {Math.max(1, Math.ceil((page?.total ?? 0) / limit))}</span>
          <button className="icon-btn sm" aria-label={t("nextRunsPage")} disabled={loading || !page || offset + limit >= page.total} onClick={() => setOffset(value => value + limit)}><ChevronRight className="ic" /></button>
        </footer>
      </> : <Empty icon={<History className="ic" />} title={t("noRecords")} desc={t("runsEmptyHint")} />}
    </Card>
    {selected && current && <Drawer wide title={current.prompt || current.session_title || t("newChat")} sub={[current.model_name, current.display_name || current.username, new Date(current.created_at).toLocaleString(getLocale(), { hour12: false })].filter(Boolean).join(" · ")} onClose={() => setSelected(null)}
      footer={<footer className="ochi-admin-df">
        <RunStatusBadge run={current} /><span className="muted tnum">{formatDuration(current.duration_ms)}</span><span className="grow" />
        {current.user_id === currentUserID && <button className="btn sm secondary" onClick={() => onNavigate(`/c/${current.session_id}`)}>{t("openConversation")}<ArrowUpRight className="ic" /></button>}
        <button className="btn sm secondary" disabled={detailLoading} onClick={() => setDetailRevision(value => value + 1)}><RefreshCw className={`ic${detailLoading ? " ic-turn" : ""}`} />{t("refresh")}</button>
      </footer>}>
      <Seg small label={t("runDetails")} value={detailTab} onChange={setDetailTab} options={[{ v: "result", l: t("content") }, { v: "tools", l: t("toolCount", { count: current.step_count }) }, { v: "metadata", l: t("data") }, { v: "requests", l: t("requestDiagnostics") }]} />
      <ErrorNotice error={detailError} />
      {detailLoading ? <SkeletonRows rows={3} /> : detail && <div id="run-detail-content" role="tabpanel" className="ochi-admin-detail-content">
        {detailTab === "result" ? <>
          <div className="ochi-admin-prompt">{detail.prompt}</div>
          {(detail.error_code || detail.error) && <div className="ochi-admin-alert"><CircleAlert className="ic" /><div>{translateError(detail.error_code) ?? detail.error}</div></div>}
          {publicReply(detail) && <div className="markdown-body"><Suspense fallback={<div>{publicReply(detail)}</div>}><MarkdownContent content={publicReply(detail)} isStreaming={false} /></Suspense></div>}
          {detail.artifacts.length > 0 && (detail.user_id === currentUserID ? <FileCards files={detail.artifacts} /> : <ul className="ochi-admin-artifact-names">{detail.artifacts.map(file => <li key={file.id}>{file.name}</li>)}</ul>)}
        </> : detailTab === "tools" ? (detail.items.flatMap((item) => item.step ? [item.step] : []).length ? detail.user_id === currentUserID ? <StepList steps={detail.items.flatMap((item) => item.step ? [item.step] : [])} /> : <ReadOnlySteps steps={detail.items.flatMap((item) => item.step ? [item.step] : [])} /> : <Empty icon={<Wrench className="ic" />} title={t("noToolCalls")} />) : detailTab === "requests" ? <RequestDiagnostics embedded key={`${detail.run_id}:${detailRevision}`} runID={detail.run_id} /> : <dl className="ochi-admin-facts">
          {[
            [t("users"), detail.display_name || detail.username], [t("provider"), detail.provider_name || "—"], [t("inputTokens"), formatTokens(detail.usage?.prompt_tokens)], [t("outputTokens"), formatTokens(detail.usage?.completion_tokens)], [t("cachedTokens"), formatTokens(detail.usage?.cached_tokens)], [t("totalDuration"), formatDuration(detail.duration_ms)], [t("update"), new Date(detail.updated_at).toLocaleString(getLocale(), { hour12: false })], [t("files"), String(detail.artifact_count)], [t("runID"), detail.run_id], [t("sessionID"), detail.session_id], [t("userID"), detail.user_id], ...(detail.resource ? [[t("resource"), detail.resource]] : []), ...(detail.archived ? [[t("version"), t("archivedVersion")]] : []),
          ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>}
      </div>}
    </Drawer>}
  </>;
}
