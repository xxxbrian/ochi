import { useEffect, useMemo, useState } from "react";
import {
  ArrowUpRight,
  ArrowLeft,
  Brain,
  ChevronDown,
  ListFilter,
  LoaderCircle,
  Paintbrush,
  Pencil,
  Plus,
  Puzzle,
  Search,
  Trash2,
} from "lucide-react";
import { api } from "../lib/api";
import type { Memory, Project } from "../lib/types";
import { Modal } from "./Modal";
import { SelectField } from "./ui/Select";
import { UserPlugins } from "./UserPlugins";
import "./settings.css";

const kinds = [
  { value: "fact", label: "事实" },
  { value: "preference", label: "偏好" },
  { value: "session_summary", label: "会话摘要" },
  { value: "project_summary", label: "项目摘要" },
];
export default function UserSettings({
  onClose,
  projects = [],
  onNavigate,
}: {
  onClose: () => void;
  projects?: Project[];
  onNavigate?: (path: string) => void;
}) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [editing, setEditing] = useState<Partial<Memory> | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all");
  const [kind, setKind] = useState("all");
  const [preferenceUpdating, setPreferenceUpdating] = useState(false);
  const [theme, setTheme] = useState(
    document.documentElement.dataset.theme ?? "light",
  );
  const [section, setSection] = useState<"appearance" | "memory" | "plugins">("appearance");
  const [filtering, setFiltering] = useState(false);
  useEffect(() => {
    let disposed = false;
    Promise.all([api.memories(), api.preferences()])
      .then(([items, preferences]) => {
        if (!disposed) {
          setMemories(items ?? []);
          setEnabled(preferences.memory_enabled);
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
  const filtered = useMemo(
    () =>
      memories.filter(
        (memory) =>
          (scope === "all" ||
            (scope === "user" && !memory.project_id) ||
            memory.project_id === scope) &&
          (kind === "all" || memory.kind === kind) &&
          memory.content.toLowerCase().includes(query.toLowerCase()),
      ),
    [memories, scope, kind, query],
  );
  async function save() {
    if (!editing?.content?.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const metadata = {
        kind: editing.kind ?? "fact",
        project_id: editing.project_id ?? "",
      };
      const memory = editing.id
        ? await api.updateMemory(editing.id, editing.content.trim(), metadata)
        : await api.addMemory(editing.content.trim(), metadata);
      setMemories((current) =>
        editing.id
          ? current.map((item) => (item.id === editing.id ? memory : item))
          : [memory, ...current],
      );
      setEditing(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: string) {
    try {
      await api.deleteMemory(id);
      setMemories((current) => current.filter((item) => item.id !== id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除失败");
    }
  }
  function setColor(value: string) {
    setTheme(value);
    document.documentElement.dataset.theme = value;
    document.documentElement.classList.toggle("dark", value === "dark");
    try {
      localStorage.setItem("assistant.theme.v1", value);
    } catch {
      /* Optional storage. */
    }
  }
  return (
    <Modal
      title="设置"
      onClose={onClose}
      size="large"
      className="ochi-settings-modal"
      bodyClassName="ochi-settings-body"
      footer={
        editing && section === "memory" ? (
          <div className="modal-actions">
            <button
              className="secondary-button"
              onClick={() => setEditing(null)}
            >
              取消
            </button>
            <button
              type="submit"
              form="memory-editor"
              className="primary-button"
              disabled={busy || !editing.content?.trim()}
            >
              {busy && <LoaderCircle className="spin" size={15} />}
              保存
            </button>
          </div>
        ) : undefined
      }
    >
      <div className="ochi-settings">
        <nav className="ochi-settings__rail" aria-label="设置分类">
          <button
            type="button"
            aria-current={section === "appearance" ? "page" : undefined}
            aria-controls="settings-appearance"
            onClick={() => setSection("appearance")}
          >
            <Paintbrush size={16} />
            外观
          </button>
          <button
            type="button"
            aria-current={section === "memory" ? "page" : undefined}
            aria-controls="settings-memory"
            onClick={() => setSection("memory")}
          >
            <Brain size={16} />
            记忆
          </button>
          <button
            type="button"
            aria-current={section === "plugins" ? "page" : undefined}
            aria-controls="settings-plugins"
            onClick={() => setSection("plugins")}
          >
            <Puzzle size={16} />
            插件
          </button>
        </nav>
        <div className="ochi-settings__content">
          {section === "appearance" ? (
            <section className="ochi-settings__panel ochi-settings__appearance" id="settings-appearance" aria-label="外观">
              <h3>外观</h3>
              <div className="ochi-settings__row">
                <strong>主题</strong>
                <SelectField
                  value={theme}
                  onChange={setColor}
                  label="主题"
                  options={[
                    { value: "light", label: "浅色" },
                    { value: "dark", label: "深色" },
                  ]}
                />
              </div>
            </section>
          ) : section === "plugins" ? <UserPlugins /> : (
            <section className="ochi-settings__panel ochi-settings__memory" id="settings-memory" aria-label="记忆">
              <div className="ochi-settings__heading">
                {editing ? <div className="ochi-settings__edit-heading">
                  <button
                    className="icon-button"
                    aria-label="返回记忆"
                    onClick={() => setEditing(null)}
                  >
                    <ArrowLeft size={17} />
                  </button>
                  <h3>{editing.id ? "编辑记忆" : "添加记忆"}</h3>
                </div> : <h3><Brain size={16} />记忆 <span>{memories.length}</span></h3>}
                {!editing && <label className="ochi-settings__switch" title="启用记忆"><input
                  type="checkbox"
                  role="switch"
                  aria-label="启用记忆"
                  checked={enabled}
                  disabled={loading || preferenceUpdating}
                  onChange={async (event) => {
                    const value = event.target.checked;
                    setPreferenceUpdating(true);
                    setError("");
                    try {
                      const preferences = await api.updatePreferences({ memory_enabled: value });
                      setEnabled(preferences.memory_enabled);
                    } catch (reason) {
                      setError(reason instanceof Error ? reason.message : "保存失败");
                    } finally {
                      setPreferenceUpdating(false);
                    }
                  }}
                /></label>}
              </div>
              {editing ? (
              <form
                id="memory-editor"
                className="admin-form ochi-settings__editor"
                onSubmit={(event) => {
                  event.preventDefault();
                  void save();
                }}
              >
                <label className="form-field">
                  <span>内容</span>
                  <textarea
                    autoFocus
                    rows={5}
                    value={editing.content ?? ""}
                    onChange={(event) =>
                      setEditing({ ...editing, content: event.target.value })
                    }
                  />
                </label>
                <div className="form-grid">
                  <label className="form-field">
                    <span>类型</span>
                    <SelectField
                      label="记忆类型"
                      value={editing.kind ?? "fact"}
                      onChange={(value) =>
                        setEditing({
                          ...editing,
                          kind: value as Memory["kind"],
                        })
                      }
                      options={kinds}
                    />
                  </label>
                  <label className="form-field">
                    <span>范围</span>
                    <SelectField
                      label="记忆范围"
                      value={editing.project_id ?? ""}
                      onChange={(project_id) =>
                        setEditing({ ...editing, project_id })
                      }
                      options={[
                        { value: "", label: "个人" },
                        ...projects.map((project) => ({
                          value: project.id,
                          label: project.name,
                        })),
                      ]}
                    />
                  </label>
                </div>
              </form>
              ) : <>
              <div className="ochi-settings__filters">
                <div className="search-input">
                  <Search size={16} />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="搜索记忆"
                    aria-label="搜索记忆"
                  />
                </div>
                  <button type="button" className={`icon-button ochi-settings__filter${filtering ? " is-active" : ""}`} aria-label="筛选记忆" title="筛选记忆" aria-expanded={filtering} aria-controls="memory-filters" onClick={() => setFiltering((value) => !value)}>
                    <ListFilter size={17} />
                    {(scope !== "all" || kind !== "all") && <span className="ochi-settings__filter-indicator" />}
                  </button>
                <button
                  className="secondary-button"
                  onClick={() => setEditing({ content: "", kind: "fact" })}
                >
                  <Plus size={16} />
                  添加
                </button>
              </div>
              {filtering && <div id="memory-filters" className="ochi-settings__filter-options">
                <SelectField
                  value={scope}
                  onChange={setScope}
                  label="记忆范围"
                  options={[
                    { value: "all", label: "全部范围" },
                    { value: "user", label: "个人" },
                    ...projects.map((project) => ({ value: project.id, label: project.name })),
                  ]}
                />
                <SelectField value={kind} onChange={setKind} label="记忆类型"
                  options={[{ value: "all", label: "全部类型" }, ...kinds]} />
                <button className="text-button" type="button" onClick={() => { setScope("all"); setKind("all"); }}>重置</button>
              </div>}
              {loading ? (
                <div className="panel-loading">
                  <LoaderCircle className="spin" size={20} />
                </div>
              ) : (
                <div className="ochi-settings__records">
                  {filtered.map((memory) => (
                    <article key={memory.id}>
                      <div className="ochi-settings__record-main">
                        <div className="ochi-settings__metadata">
                          <span>
                            {kinds.find((item) => item.value === memory.kind)
                              ?.label ?? "事实"}
                          </span>
                          <span>
                            {memory.project_id
                              ? (projects.find(
                                  (project) => project.id === memory.project_id,
                                )?.name ?? "项目")
                              : "个人"}
                          </span>
                          <span>
                            {memory.source === "automatic"
                              ? "自动"
                              : memory.source === "agent"
                                ? "Agent"
                                : "手动"}
                          </span>
                        </div>
                        <p>{memory.content}</p>
                        <div className="ochi-settings__source">
                          <time>
                            {new Date(
                              memory.updated_at ?? memory.created_at,
                            ).toLocaleDateString("zh-CN", {
                              month: "short",
                              day: "numeric",
                            })}
                          </time>
                          {memory.source_session_id && (
                            <button
                              className="text-button"
                              onClick={() => {
                                onClose();
                                onNavigate?.(`/c/${memory.source_session_id}`);
                              }}
                            >
                              来源对话
                              <ArrowUpRight size={13} />
                            </button>
                          )}
                        </div>
                        {memory.source_excerpt && (
                          <details className="ochi-settings__excerpt">
                            <summary>
                              来源片段
                              <ChevronDown size={13} />
                            </summary>
                            <blockquote>{memory.source_excerpt}</blockquote>
                          </details>
                        )}
                      </div>
                      <div className="ochi-settings__record-actions">
                        <button
                          className="icon-button"
                          onClick={() => setEditing(memory)}
                          aria-label="编辑记忆"
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          className="icon-button danger"
                          onClick={() => void remove(memory.id)}
                          aria-label="删除记忆"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </article>
                  ))}
                  {!filtered.length && (
                    <div className="ochi-settings__empty">{query || kind !== "all" || scope !== "all" ? "没有找到记忆" : "暂无记忆"}</div>
                  )}
                </div>
              )}
              </>}
            </section>
          )}
          {error && section === "memory" && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}
