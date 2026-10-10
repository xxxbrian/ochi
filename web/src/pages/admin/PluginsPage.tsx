import { useEffect, useMemo, useRef, useState } from "react";
import { FileCode2, LoaderCircle, Pencil, Plug, Plus, Puzzle, RefreshCw, Trash2 } from "lucide-react";
import { adminApi } from "../../lib/api";
import type { Plugin, PluginComponent, PluginComponents, PluginConfig } from "../../lib/types";
import { Modal } from "../../components/Modal";
import { Field, Toggle } from "./Fields";
import { MCPPage, SkillsPage } from "./IntegrationsPage";
import "./plugins.css";

const emptyComponents: PluginComponents = { skills: [], mcp: [] };
const sections = [
  { id: "plugins", label: "插件" },
  { id: "skills", label: "Skill 组件" },
  { id: "mcp", label: "MCP 组件" },
];

export default function PluginsPage({ section, onNavigate }: { section: string; onNavigate: (path: string) => void }) {
  return <>
    <nav className="plugins-sections" aria-label="插件管理">
      {sections.map((item) => <button key={item.id} aria-current={section === item.id ? "page" : undefined} onClick={() => onNavigate(`/admin/${item.id}`)}>{item.label}</button>)}
    </nav>
    {section === "skills" ? <SkillsPage /> : section === "mcp" ? <MCPPage /> : <PluginCatalog />}
  </>;
}

function PluginCatalog() {
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
      setError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy("");
    }
  }
  async function save() {
    if (!editor || busyRef.current) return;
    if (!editor.skill_ids.length && !editor.mcp_ids.length) {
      setEditorError("请至少选择一个组件");
      return;
    }
    if (editor.skill_ids.length + editor.mcp_ids.length > 64) {
      setEditorError("每个插件最多选择 64 个组件");
      return;
    }
    if (new TextEncoder().encode(editor.description).length > 4000) {
      setEditorError("描述过长，请精简后重试");
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
      if (mounted.current) setEditorError(reason instanceof Error ? reason.message : "保存失败");
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
      if (mounted.current) setDeleteError(reason instanceof Error ? reason.message : "删除失败");
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy("");
    }
  }

  const unavailable = loading || Boolean(busy);
  return <>
    <div className="admin-page-heading">
      <h2>插件</h2>
      <div className="toolbar-actions">
        <button className="icon-button" aria-label="刷新插件" title="刷新插件" disabled={unavailable} onClick={() => setRevision((value) => value + 1)}><RefreshCw size={17} /></button>
        <button className="primary-button" disabled={unavailable || !loaded} onClick={() => edit()}><Plus size={16} />添加插件</button>
      </div>
    </div>
    {error && <div className="plugins-error" role="alert"><p>{error}</p><button className="text-button" disabled={unavailable} onClick={() => setRevision((value) => value + 1)}>重试</button></div>}
    {loading && !loaded ? <div className="panel-loading" role="status"><LoaderCircle className="spin" size={22} /><span className="sr-only">加载插件</span></div> : loaded ? <div className="plugins-catalog" aria-busy={loading}>
      <div className="plugins-catalog__labels" aria-hidden="true"><span>名称</span><span>组件</span><span>默认开启</span><span>可用</span><span /></div>
      {items.map((plugin) => <article key={plugin.id} className={!plugin.enabled ? "is-disabled" : undefined}>
        <button className="plugins-catalog__main" disabled={unavailable} onClick={() => edit(plugin)}>
          <Puzzle size={19} aria-hidden="true" />
          <span><strong>{plugin.name}</strong>{plugin.description ? <small>{plugin.description}</small> : <small>{plugin.id}</small>}</span>
        </button>
        <div className="plugins-catalog__components" aria-label={`${plugin.skill_ids?.length ?? 0} 个 Skill，${plugin.mcp_ids?.length ?? 0} 个 MCP`}>
          {Boolean(plugin.skill_ids?.length) && <span><FileCode2 size={14} />{plugin.skill_ids.length}</span>}
          {Boolean(plugin.mcp_ids?.length) && <span><Plug size={14} />{plugin.mcp_ids.length}</span>}
        </div>
        <label className="plugins-catalog__switch" title="默认开启的插件，用户不可关闭">
          <span>默认开启</span>
          <input type="checkbox" role="switch" aria-label={`默认开启 ${plugin.name}`} checked={plugin.default_enabled} disabled={unavailable} onChange={(event) => void update(plugin, { default_enabled: event.target.checked })} />
        </label>
        <label className="plugins-catalog__switch">
          <span>可用</span>
          <input type="checkbox" role="switch" aria-label={`向用户提供 ${plugin.name}`} checked={plugin.enabled} disabled={unavailable} onChange={(event) => void update(plugin, { enabled: event.target.checked })} />
        </label>
        <div className="admin-row-actions">
          {busy === plugin.id && <LoaderCircle className="spin plugins-catalog__pending" size={15} aria-label="保存中" />}
          <button className="icon-button" title="编辑插件" aria-label={`编辑 ${plugin.name}`} disabled={unavailable} onClick={() => edit(plugin)}><Pencil size={16} /></button>
          <button className="icon-button admin-delete-action" title="删除插件" aria-label={`删除 ${plugin.name}`} disabled={unavailable} onClick={() => { setDeleting(plugin); setDeleteError(""); }}><Trash2 size={16} /></button>
        </div>
      </article>)}
      {!items.length && <div className="table-empty">暂无插件</div>}
    </div> : null}

    {editor && <Modal title={existing ? "编辑插件" : "添加插件"} onClose={() => { if (!busyRef.current) setEditor(null); }} size="large" footer={<>
      <button className="secondary-button" disabled={Boolean(busy)} onClick={() => setEditor(null)}>取消</button>
      <button className="primary-button" type="submit" form="plugin-editor" disabled={Boolean(busy) || !editor.name.trim() || !editor.id.trim()}>{busy === "save" && <LoaderCircle className="spin" size={15} />}保存</button>
    </>}>
      <form id="plugin-editor" className="admin-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <fieldset className="plugin-editor__fields" disabled={Boolean(busy)}>
          <div className="form-grid">
            <Field title="名称"><input autoFocus required maxLength={100} value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} /></Field>
            <Field title="标识"><input required pattern={"[a-z0-9][a-z0-9_\\-]{0,63}"} title="小写字母、数字、- 或 _，创建后不可修改" maxLength={64} autoCapitalize="none" spellCheck={false} readOnly={existing} value={editor.id} placeholder="research" onChange={(event) => setEditor({ ...editor, id: event.target.value })} /></Field>
          </div>
          <Field title="描述"><textarea rows={2} maxLength={4000} value={editor.description} onChange={(event) => setEditor({ ...editor, description: event.target.value })} /></Field>
          <div className="plugin-editor__policy">
            <Toggle title="向用户提供" value={editor.enabled} onChange={(enabled) => setEditor({ ...editor, enabled })} />
            <Toggle title="默认开启（用户不可关闭）" value={editor.default_enabled} onChange={(default_enabled) => setEditor({ ...editor, default_enabled })} />
          </div>
          <div className="plugin-editor__components">
            <ComponentPicker title="Skill 组件" items={components.skills} selected={editor.skill_ids} owners={owners.skills} pluginId={existing ? editor.id : undefined} onChange={(skill_ids) => setEditor({ ...editor, skill_ids })} />
            <ComponentPicker title="MCP 组件" items={components.mcp} selected={editor.mcp_ids} owners={owners.mcp} pluginId={existing ? editor.id : undefined} onChange={(mcp_ids) => setEditor({ ...editor, mcp_ids })} />
          </div>
        </fieldset>
        {editorError && <p className="form-error" role="alert">{editorError}</p>}
      </form>
    </Modal>}
    {deleting && <Modal title="删除插件？" size="small" onClose={() => { if (!busyRef.current) setDeleting(null); }} footer={<>
      <button className="secondary-button" disabled={Boolean(busy)} onClick={() => setDeleting(null)}>取消</button>
      <button className="primary-button danger-button" disabled={Boolean(busy)} onClick={() => void remove()}>{busy === "delete" && <LoaderCircle className="spin" size={15} />}删除</button>
    </>}><p>删除「{deleting.name}」后，用户将无法再使用此插件。</p>{deleteError && <p className="form-error" role="alert">{deleteError}</p>}</Modal>}
  </>;
}

function ComponentPicker({ title, items, selected, owners, pluginId, onChange }: {
  title: string; items: PluginComponent[]; selected: string[]; owners: Map<string, Plugin>; pluginId?: string; onChange: (value: string[]) => void;
}) {
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
          <span><strong>{component.name || component.id}</strong>{assigned ? <small>已用于 {owner.name}</small> : <small>{!component.enabled ? "已停用" : component.description || component.id}</small>}</span>
        </label>;
      })}
      {missing.map((id) => <label key={id} className="is-missing"><input type="checkbox" checked onChange={() => onChange(selected.filter((value) => value !== id))} /><span><strong>{id}</strong><small>组件已移除</small></span></label>)}
      {!items.length && !missing.length && <p>暂无组件</p>}
    </div>
  </fieldset>;
}
