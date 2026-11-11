import { t, useAdminI18n } from "./i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, FileCode2, MoreHorizontal, Pencil, Plug, Plus, Puzzle, RefreshCw, Trash2 } from "lucide-react";
import { adminApi } from "../../lib/api";
import type { Plugin, PluginComponent, PluginComponents, PluginConfig } from "../../lib/types";
import { Modal } from "../../components/Modal";
import { Field, Toggle } from "./Fields";
import { ActionMenu, MenuAction } from "../../components/ui/Menu";
import { Card, CardHead, Empty, Pill, SkeletonRows, Switch } from "./ui";
import { MCPPage, SkillsPage } from "./IntegrationsPage";

const emptyComponents: PluginComponents = { skills: [], mcp: [] };
/** Lab "plugins" page: skills, MCP servers and plugin bundles stack as cards. The legacy /admin/skills and /admin/mcp routes land here too. */
export default function PluginsPage(_props: { section: string; onNavigate: (path: string) => void }) {
  useAdminI18n();
  return <>
    <SkillsPage />
    <MCPPage />
    <PluginCatalog />
  </>;
}

function PluginCatalog() {
  useAdminI18n();
  const [items, setItems] = useState<Plugin[]>([]);
  const [components, setComponents] = useState<PluginComponents>(emptyComponents);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [editor, setEditor] = useState<PluginConfig | null>(null);
  const [existing, setExisting] = useState(false);
  const [editorError, setEditorError] = useState("");
  const [deleting, setDeleting] = useState<Plugin | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [busy, setBusy] = useState("");
  const mounted = useRef(false);
  const busyRef = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void Promise.all([adminApi.plugins(controller.signal), adminApi.pluginComponents(controller.signal)])
      .then(([plugins, available]) => {
        if (controller.signal.aborted) return;
        setItems(plugins ?? []);
        setComponents({ skills: available.skills ?? [], mcp: available.mcp ?? [] });
        setLoaded(true);
      })
      .catch((reason: Error) => { if (!controller.signal.aborted) setError(reason.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);

  const owners = useMemo(() => {
    const skills = new Map<string, Plugin>();
    const mcp = new Map<string, Plugin>();
    for (const item of items) {
      for (const id of item.skill_ids ?? []) skills.set(id, item);
      for (const id of item.mcp_ids ?? []) mcp.set(id, item);
    }
    return { skills, mcp };
  }, [items]);

  function edit(plugin?: Plugin) {
    setEditor(plugin ? {
      id: plugin.id, name: plugin.name, description: plugin.description,
      enabled: plugin.enabled, default_enabled: plugin.default_enabled,
      skill_ids: [...(plugin.skill_ids ?? [])], mcp_ids: [...(plugin.mcp_ids ?? [])],
    } : { id: "", name: "", description: "", enabled: true, default_enabled: false, skill_ids: [], mcp_ids: [] });
    setExisting(Boolean(plugin));
    setEditorError("");
  }
  function replacePlugin(value: Plugin) {
    setItems((current) => current.some((item) => item.id === value.id)
      ? current.map((item) => item.id === value.id ? value : item)
      : [...current, value]);
  }
  async function update(plugin: Plugin, patch: Partial<Pick<Plugin, "enabled" | "default_enabled">>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(plugin.id);
    setError("");
    replacePlugin({ ...plugin, ...patch });
    try {
      const value = await adminApi.updatePlugin(plugin.id, patch);
      if (mounted.current) replacePlugin(value);
    } catch (reason) {
      if (!mounted.current) return;
      replacePlugin(plugin);
      setError(reason instanceof Error ? reason.message : t("saveFailed"));
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy("");
    }
  }
  async function save() {
    if (!editor || busyRef.current) return;
    if (!editor.skill_ids.length && !editor.mcp_ids.length) {
      setEditorError(t("chooseComponent"));
      return;
    }
    if (editor.skill_ids.length + editor.mcp_ids.length > 64) {
      setEditorError(t("componentLimit"));
      return;
    }
    if (new TextEncoder().encode(editor.description).length > 4000) {
      setEditorError(t("descriptionTooLong"));
      return;
    }
    busyRef.current = true;
    setBusy("save");
    setEditorError("");
    try {
      const value = await adminApi.savePlugin({ ...editor, id: editor.id.trim(), name: editor.name.trim(), description: editor.description.trim() }, existing);
      if (!mounted.current) return;
      replacePlugin(value);
      setEditor(null);
    } catch (reason) {
      if (mounted.current) setEditorError(reason instanceof Error ? reason.message : t("saveFailed"));
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy("");
    }
  }
  async function remove() {
    if (!deleting || busyRef.current) return;
    busyRef.current = true;
    setBusy("delete");
    setDeleteError("");
    try {
      await adminApi.deletePlugin(deleting.id);
      if (!mounted.current) return;
      setItems((current) => current.filter((item) => item.id !== deleting.id));
      setDeleting(null);
    } catch (reason) {
      if (mounted.current) setDeleteError(reason instanceof Error ? reason.message : t("deleteFailed"));
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy("");
    }
  }

  const unavailable = loading || Boolean(busy);
  return <>
    <Card>
      <CardHead title={t("plugins")} desc={t("pluginsCardHint", { count: items.length })}
        right={<>
          <button className="icon-btn sm" aria-label={t("refreshPlugins")} title={t("refreshPlugins")} disabled={unavailable} onClick={() => setRevision((value) => value + 1)}><RefreshCw className={`ic${loading ? " ic-turn" : ""}`} /></button>
          <button className="btn primary sm" disabled={unavailable || !loaded} onClick={() => edit()}><Plus className="ic" />{t("addPlugin")}</button>
        </>} />
      {error && <div className="ad-alert" role="alert"><CircleAlert className="ic" /><div>{error}</div><button className="btn sm secondary" disabled={unavailable} onClick={() => setRevision((value) => value + 1)}>{t("retry")}</button></div>}
      {loading && !loaded ? <div className="ad-plist"><SkeletonRows rows={2} /></div> : loaded ? (items.length ? <div className="ad-plist" aria-busy={loading}>
        {items.map((plugin) => (
          <div className="ad-prow" key={plugin.id}>
            <div className="ad-prow-h">
              <span className="ad-tile"><Puzzle className="ic" /></span>
              <button type="button" className="ad-prow-t ad-rowbtn" disabled={unavailable} onClick={() => edit(plugin)}>
                <b>{plugin.name}</b><small>{plugin.description || plugin.id}</small>
              </button>
              <span className="ad-pcol ad-counts" aria-label={t("pluginComponentsCount", { skills: plugin.skill_ids?.length ?? 0, mcp: plugin.mcp_ids?.length ?? 0 })}>
                {Boolean(plugin.skill_ids?.length) && <Pill><FileCode2 className="ic" />{plugin.skill_ids.length}</Pill>}
                {Boolean(plugin.mcp_ids?.length) && <Pill><Plug className="ic" />{plugin.mcp_ids.length}</Pill>}
              </span>
              <label className="ad-mini" title={t("mandatoryPluginHint")}><span>{t("enabledByDefault")}</span>
                <Switch on={plugin.default_enabled} label={t("mandatoryNamed", { name: plugin.name })} disabled={unavailable} busy={busy === plugin.id} onChange={(next) => void update(plugin, { default_enabled: next })} /></label>
              <label className="ad-mini"><span>{t("available")}</span>
                <Switch on={plugin.enabled} label={t("publishNamed", { name: plugin.name })} disabled={unavailable} busy={busy === plugin.id} onChange={(next) => void update(plugin, { enabled: next })} /></label>
              <ActionMenu trigger={<MoreHorizontal className="ic" />} label={t("editNamed", { name: plugin.name })} className="icon-btn sm">
                <MenuAction onClick={() => edit(plugin)}><Pencil className="ic" />{t("editPlugin")}</MenuAction>
                <MenuAction danger onClick={() => { setDeleting(plugin); setDeleteError(""); }}><Trash2 className="ic" />{t("deletePlugin")}</MenuAction>
              </ActionMenu>
            </div>
          </div>
        ))}
      </div> : <Empty icon={<Puzzle className="ic" />} title={t("noPlugins")} />) : null}
    </Card>

    {editor && <Modal title={existing ? t("editPlugin") : t("addPlugin")} dismissible={!busy} onClose={() => setEditor(null)} size="large" footer={<>
      <button className="btn secondary" disabled={Boolean(busy)} onClick={() => setEditor(null)}>{t("cancel")}</button>
      <button className={`btn primary${busy === "save" ? " btn-progress" : ""}`} type="submit" form="plugin-editor" disabled={Boolean(busy) || !editor.name.trim() || !editor.id.trim()}>{busy === "save" ? t("savingEllipsis") : t("save")}</button>
    </>}>
      <form id="plugin-editor" className="admin-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <fieldset className="ad-fieldset" disabled={Boolean(busy)}>
          <div className="ad-grid2">
            <Field title={t("name")}><input className="input" autoFocus required maxLength={100} value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} /></Field>
            <Field title={t("identifier")}><input className="input mono" required pattern={"[a-z0-9][a-z0-9_\\-]{0,63}"} title={t("identifierHint")} maxLength={64} autoCapitalize="none" spellCheck={false} readOnly={existing} value={editor.id} placeholder="research" onChange={(event) => setEditor({ ...editor, id: event.target.value })} /></Field>
          </div>
          <Field title={t("description")}><textarea className="textarea" rows={2} maxLength={4000} value={editor.description} onChange={(event) => setEditor({ ...editor, description: event.target.value })} /></Field>
          <div className="ad-policy">
            <Toggle title={t("publishToUsers")} value={editor.enabled} onChange={(enabled) => setEditor({ ...editor, enabled })} />
            <Toggle title={t("mandatoryPlugin")} value={editor.default_enabled} onChange={(default_enabled) => setEditor({ ...editor, default_enabled })} />
          </div>
          <div className="ad-cols2">
            <ComponentPicker title={t("skillComponents")} items={components.skills} selected={editor.skill_ids} owners={owners.skills} pluginId={existing ? editor.id : undefined} onChange={(skill_ids) => setEditor({ ...editor, skill_ids })} />
            <ComponentPicker title={t("mcpComponents")} items={components.mcp} selected={editor.mcp_ids} owners={owners.mcp} pluginId={existing ? editor.id : undefined} onChange={(mcp_ids) => setEditor({ ...editor, mcp_ids })} />
          </div>
        </fieldset>
        {editorError && <p className="ad-alert" role="alert">{editorError}</p>}
      </form>
    </Modal>}
    {deleting && <Modal title={t("deletePluginQuestion")} size="small" dismissible={!busy} onClose={() => setDeleting(null)} footer={<>
      <button className="btn secondary" disabled={Boolean(busy)} onClick={() => setDeleting(null)}>{t("cancel")}</button>
      <button className={`btn danger${busy === "delete" ? " btn-progress" : ""}`} disabled={Boolean(busy)} onClick={() => void remove()}>{busy === "delete" ? t("deletingEllipsis") : t("delete")}</button>
    </>}><p>{t("pluginDeleteDescription", { name: deleting.name })}</p>{deleteError && <p className="ad-alert" role="alert">{deleteError}</p>}</Modal>}
  </>;
}

function ComponentPicker({ title, items, selected, owners, pluginId, onChange }: {
  title: string; items: PluginComponent[]; selected: string[]; owners: Map<string, Plugin>; pluginId?: string; onChange: (value: string[]) => void;
}) {
  useAdminI18n();
  const known = new Set(items.map((item) => item.id));
  const missing = selected.filter((id) => !known.has(id));
  return <fieldset className="ad-cgroup">
    <legend>{title}<span>{selected.length}</span></legend>
    <div className="ad-cgroup-list">
      {items.map((component) => {
        const owner = owners.get(component.id);
        const assigned = owner && owner.id !== pluginId;
        return <label key={component.id} className={assigned ? "is-assigned" : undefined}>
          <input type="checkbox" checked={selected.includes(component.id)} disabled={Boolean(assigned)} onChange={(event) => onChange(event.target.checked ? [...selected, component.id] : selected.filter((id) => id !== component.id))} />
          <span><strong>{component.name || component.id}</strong>{assigned ? <small>{t("usedBy")}{owner.name}</small> : <small>{!component.enabled ? t("disabled") : component.description || component.id}</small>}</span>
        </label>;
      })}
      {missing.map((id) => <label key={id} className="is-missing"><input type="checkbox" checked onChange={() => onChange(selected.filter((value) => value !== id))} /><span><strong>{id}</strong><small>{t("componentRemoved")}</small></span></label>)}
      {!items.length && !missing.length && <p>{t("noComponents")}</p>}
    </div>
  </fieldset>;
}
