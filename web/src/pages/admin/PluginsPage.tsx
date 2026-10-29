import { t, useAdminI18n } from "./i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { FileCode2, LoaderCircle, Pencil, Plug, Plus, Puzzle, RefreshCw, Trash2 } from "lucide-react";
import { adminApi } from "../../lib/api";
import type { Plugin, PluginComponent, PluginComponents, PluginConfig } from "../../lib/types";
import { Modal } from "../../components/Modal";
import { Field, Toggle } from "./Fields";
import { MCPPage, SkillsPage } from "./IntegrationsPage";
import "./plugins.css";

const emptyComponents: PluginComponents = { skills: [], mcp: [] };
function pluginSections() { return [
  { id: "plugins", label: t("plugins") },
  { id: "skills", label: t("skillComponents") },
  { id: "mcp", label: t("mcpComponents") },
]; }

export default function PluginsPage({ section, onNavigate }: { section: string; onNavigate: (path: string) => void }) {
  useAdminI18n();
  return <>
    <nav className="plugins-sections" aria-label={t("pluginManagement")}>
      {pluginSections().map((item) => <button key={item.id} aria-current={section === item.id ? "page" : undefined} onClick={() => onNavigate(`/admin/${item.id}`)}>{item.label}</button>)}
    </nav>
    {section === "skills" ? <SkillsPage /> : section === "mcp" ? <MCPPage /> : <PluginCatalog />}
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
    <div className="admin-page-heading">
      <h2>{t("plugins")}</h2>
      <div className="toolbar-actions">
        <button className="icon-button" aria-label={t("refreshPlugins")} title={t("refreshPlugins")} disabled={unavailable} onClick={() => setRevision((value) => value + 1)}><RefreshCw size={17} /></button>
        <button className="primary-button" disabled={unavailable || !loaded} onClick={() => edit()}><Plus size={16} />{t("addPlugin")}</button>
      </div>
    </div>
    {error && <div className="plugins-error" role="alert"><p>{error}</p><button className="text-button" disabled={unavailable} onClick={() => setRevision((value) => value + 1)}>{t("retry")}</button></div>}
    {loading && !loaded ? <div className="panel-loading" role="status"><LoaderCircle className="spin" size={22} /><span className="sr-only">{t("loadingPlugins")}</span></div> : loaded ? <div className="plugins-catalog" aria-busy={loading}>
      <div className="plugins-catalog__labels" aria-hidden="true"><span>{t("name")}</span><span>{t("components")}</span><span>{t("enabledByDefault")}</span><span>{t("available")}</span><span /></div>
      {items.map((plugin) => <article key={plugin.id} className={!plugin.enabled ? "is-disabled" : undefined}>
        <button className="plugins-catalog__main" disabled={unavailable} onClick={() => edit(plugin)}>
          <Puzzle size={19} aria-hidden="true" />
          <span><strong>{plugin.name}</strong>{plugin.description ? <small>{plugin.description}</small> : <small>{plugin.id}</small>}</span>
        </button>
        <div className="plugins-catalog__components" aria-label={t("pluginComponentsCount", { skills: plugin.skill_ids?.length ?? 0, mcp: plugin.mcp_ids?.length ?? 0 })}>
          {Boolean(plugin.skill_ids?.length) && <span><FileCode2 size={14} />{plugin.skill_ids.length}</span>}
          {Boolean(plugin.mcp_ids?.length) && <span><Plug size={14} />{plugin.mcp_ids.length}</span>}
        </div>
        <label className="plugins-catalog__switch" title={t("mandatoryPluginHint")}>
          <span>{t("enabledByDefault")}</span>
          <input type="checkbox" role="switch" aria-label={t("mandatoryNamed", { name: plugin.name })} checked={plugin.default_enabled} disabled={unavailable} onChange={(event) => void update(plugin, { default_enabled: event.target.checked })} />
        </label>
        <label className="plugins-catalog__switch">
          <span>{t("available")}</span>
          <input type="checkbox" role="switch" aria-label={t("publishNamed", { name: plugin.name })} checked={plugin.enabled} disabled={unavailable} onChange={(event) => void update(plugin, { enabled: event.target.checked })} />
        </label>
        <div className="admin-row-actions">
          {busy === plugin.id && <LoaderCircle className="spin plugins-catalog__pending" size={15} aria-label={t("saving")} />}
          <button className="icon-button" title={t("editPlugin")} aria-label={t("editNamed", { name: plugin.name })} disabled={unavailable} onClick={() => edit(plugin)}><Pencil size={16} /></button>
          <button className="icon-button admin-delete-action" title={t("deletePlugin")} aria-label={t("deleteNamed", { name: plugin.name })} disabled={unavailable} onClick={() => { setDeleting(plugin); setDeleteError(""); }}><Trash2 size={16} /></button>
        </div>
      </article>)}
      {!items.length && <div className="table-empty">{t("noPlugins")}</div>}
    </div> : null}

    {editor && <Modal title={existing ? t("editPlugin") : t("addPlugin")} onClose={() => { if (!busyRef.current) setEditor(null); }} size="large" footer={<>
      <button className="secondary-button" disabled={Boolean(busy)} onClick={() => setEditor(null)}>{t("cancel")}</button>
      <button className="primary-button" type="submit" form="plugin-editor" disabled={Boolean(busy) || !editor.name.trim() || !editor.id.trim()}>{busy === "save" && <LoaderCircle className="spin" size={15} />}{t("save")}</button>
    </>}>
      <form id="plugin-editor" className="admin-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <fieldset className="plugin-editor__fields" disabled={Boolean(busy)}>
          <div className="form-grid">
            <Field title={t("name")}><input autoFocus required maxLength={100} value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} /></Field>
            <Field title={t("identifier")}><input required pattern={"[a-z0-9][a-z0-9_\\-]{0,63}"} title={t("identifierHint")} maxLength={64} autoCapitalize="none" spellCheck={false} readOnly={existing} value={editor.id} placeholder="research" onChange={(event) => setEditor({ ...editor, id: event.target.value })} /></Field>
          </div>
          <Field title={t("description")}><textarea rows={2} maxLength={4000} value={editor.description} onChange={(event) => setEditor({ ...editor, description: event.target.value })} /></Field>
          <div className="plugin-editor__policy">
            <Toggle title={t("publishToUsers")} value={editor.enabled} onChange={(enabled) => setEditor({ ...editor, enabled })} />
            <Toggle title={t("mandatoryPlugin")} value={editor.default_enabled} onChange={(default_enabled) => setEditor({ ...editor, default_enabled })} />
          </div>
          <div className="plugin-editor__components">
            <ComponentPicker title={t("skillComponents")} items={components.skills} selected={editor.skill_ids} owners={owners.skills} pluginId={existing ? editor.id : undefined} onChange={(skill_ids) => setEditor({ ...editor, skill_ids })} />
            <ComponentPicker title={t("mcpComponents")} items={components.mcp} selected={editor.mcp_ids} owners={owners.mcp} pluginId={existing ? editor.id : undefined} onChange={(mcp_ids) => setEditor({ ...editor, mcp_ids })} />
          </div>
        </fieldset>
        {editorError && <p className="form-error" role="alert">{editorError}</p>}
      </form>
    </Modal>}
    {deleting && <Modal title={t("deletePluginQuestion")} size="small" onClose={() => { if (!busyRef.current) setDeleting(null); }} footer={<>
      <button className="secondary-button" disabled={Boolean(busy)} onClick={() => setDeleting(null)}>{t("cancel")}</button>
      <button className="primary-button danger-button" disabled={Boolean(busy)} onClick={() => void remove()}>{busy === "delete" && <LoaderCircle className="spin" size={15} />}{t("delete")}</button>
    </>}><p>{t("pluginDeleteDescription", { name: deleting.name })}</p>{deleteError && <p className="form-error" role="alert">{deleteError}</p>}</Modal>}
  </>;
}

function ComponentPicker({ title, items, selected, owners, pluginId, onChange }: {
  title: string; items: PluginComponent[]; selected: string[]; owners: Map<string, Plugin>; pluginId?: string; onChange: (value: string[]) => void;
}) {
  useAdminI18n();
  const known = new Set(items.map((item) => item.id));
  const missing = selected.filter((id) => !known.has(id));
  return <fieldset className="plugin-component-group">
    <legend>{title}<span>{selected.length}</span></legend>
    <div className="plugin-component-group__list">
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
