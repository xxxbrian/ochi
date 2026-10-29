import { t, useI18n, getLocale, type LanguagePreference } from "../lib/i18n";
import { useEffect, useMemo, useRef, useState } from "react";
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


export default function UserSettings({
  onClose,
  projects = [],
  onNavigate,
  onLanguage,
}: {
  onClose: () => void;
  projects?: Project[];
  onNavigate?: (path: string) => void;
  onLanguage: (language: LanguagePreference) => Promise<void>;
}) {
  const { language } = useI18n();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const kinds = [
  { value: "fact", label: t("memory.fact") },
  { value: "preference", label: t("memory.preference") },
  { value: "session_summary", label: t("memory.sessionSummary") },
  { value: "project_summary", label: t("memory.projectSummary") },
];
  const [languageSaving, setLanguageSaving] = useState(false);
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
      setError(reason instanceof Error ? reason.message : t("error.save"));
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: string) {
    try {
      await api.deleteMemory(id);
      setMemories((current) => current.filter((item) => item.id !== id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("error.delete"));
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
      title={t("settings.title")}
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
              {t("common.cancel")}
            </button>
            <button
              type="submit"
              form="memory-editor"
              className="primary-button"
              disabled={busy || !editing.content?.trim()}
            >
              {busy && <LoaderCircle className="spin" size={15} />}
              {t("common.save")}
            </button>
          </div>
        ) : undefined
      }
    >
      <div className="ochi-settings">
        <nav className="ochi-settings__rail" aria-label={t("settings.categories")}>
          <button
            type="button"
            aria-current={section === "appearance" ? "page" : undefined}
            aria-controls="settings-appearance"
            onClick={() => setSection("appearance")}
          >
            <Paintbrush size={16} />
            {t("settings.appearance")}
          </button>
          <button
            type="button"
            aria-current={section === "memory" ? "page" : undefined}
            aria-controls="settings-memory"
            onClick={() => setSection("memory")}
          >
            <Brain size={16} />
            {t("memory.title")}
          </button>
          <button
            type="button"
            aria-current={section === "plugins" ? "page" : undefined}
            aria-controls="settings-plugins"
            onClick={() => setSection("plugins")}
          >
            <Puzzle size={16} />
            {t("plugins.title")}
          </button>
        </nav>
        <div className="ochi-settings__content" key={section}>
          {section === "appearance" ? (
            <section className="ochi-settings__panel ochi-settings__appearance" id="settings-appearance" aria-label={t("settings.appearance")}>
              <h3>{t("settings.appearance")}</h3>
              <div className="ochi-settings__row">
                <strong>{t("settings.theme")}</strong>
                <SelectField
                  value={theme}
                  onChange={setColor}
                  label={t("settings.theme")}
                  options={[
                    { value: "light", label: t("settings.light") },
                    { value: "dark", label: t("settings.dark") },
                  ]}
                />
              </div>
              <div className="ochi-settings__row">
                <strong>{t("settings.language")}</strong>
                <SelectField
                  value={language}
                  label={t("settings.language")}
                  disabled={languageSaving}
                  onChange={(value) => {
                    setLanguageSaving(true);
                    setError("");
                    void onLanguage(value as LanguagePreference).catch((reason: unknown) => {
                      if (mounted.current) setError(reason instanceof Error ? reason.message : t("error.save"));
                    }).finally(() => {
                      if (mounted.current) setLanguageSaving(false);
                    });
                  }}
                  options={[
                    { value: "system", label: t("settings.systemLanguage") },
                    { value: "en", label: t("settings.languageEnglish") },
                    { value: "zh-CN", label: t("settings.languageSimplified") },
                    { value: "zh-TW", label: t("settings.languageTraditional") },
                  ]}
                />
              </div>
            </section>
          ) : section === "plugins" ? <UserPlugins /> : (
            <section className="ochi-settings__panel ochi-settings__memory" id="settings-memory" aria-label={t("memory.title")}>
              <div className="ochi-settings__heading">
                {editing ? <div className="ochi-settings__edit-heading">
                  <button
                    className="icon-button"
                    aria-label={t("memory.back")}
                    onClick={() => setEditing(null)}
                  >
                    <ArrowLeft size={17} />
                  </button>
                  <h3>{editing.id ? t("memory.edit") : t("memory.add")}</h3>
                </div> : <h3><Brain size={16} />{t("memory.title")} <span>{memories.length}</span></h3>}
                {!editing && <label className="ochi-settings__switch" title={t("memory.enable")}><input
                  type="checkbox"
                  role="switch"
                  aria-label={t("memory.enable")}
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
                      setError(reason instanceof Error ? reason.message : t("error.save"));
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
                  <span>{t("common.content")}</span>
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
                    <span>{t("common.type")}</span>
                    <SelectField
                      label={t("memory.kind")}
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
                    <span>{t("memory.scope")}</span>
                    <SelectField
                      label={t("memory.scopeLabel")}
                      value={editing.project_id ?? ""}
                      onChange={(project_id) =>
                        setEditing({ ...editing, project_id })
                      }
                      options={[
                        { value: "", label: t("memory.personal") },
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
                    placeholder={t("memory.search")}
                    aria-label={t("memory.search")}
                  />
                </div>
                  <button type="button" className={`icon-button ochi-settings__filter${filtering ? " is-active" : ""}`} aria-label={t("memory.filter")} title={t("memory.filter")} aria-expanded={filtering} aria-controls="memory-filters" onClick={() => setFiltering((value) => !value)}>
                    <ListFilter size={17} />
                    {(scope !== "all" || kind !== "all") && <span className="ochi-settings__filter-indicator" />}
                  </button>
                <button
                  className="secondary-button"
                  onClick={() => setEditing({ content: "", kind: "fact" })}
                >
                  <Plus size={16} />
                  {t("common.add")}
                </button>
              </div>
              {filtering && <div id="memory-filters" className="ochi-settings__filter-options">
                <SelectField
                  value={scope}
                  onChange={setScope}
                  label={t("memory.scopeLabel")}
                  options={[
                    { value: "all", label: t("memory.allScopes") },
                    { value: "user", label: t("memory.personal") },
                    ...projects.map((project) => ({ value: project.id, label: project.name })),
                  ]}
                />
                <SelectField value={kind} onChange={setKind} label={t("memory.kind")}
                  options={[{ value: "all", label: t("memory.allKinds") }, ...kinds]} />
                <button className="text-button" type="button" onClick={() => { setScope("all"); setKind("all"); }}>{t("common.reset")}</button>
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
                              ?.label ?? t("memory.fact")}
                          </span>
                          <span>
                            {memory.project_id
                              ? (projects.find(
                                  (project) => project.id === memory.project_id,
                                )?.name ?? t("projects.title"))
                              : t("memory.personal")}
                          </span>
                          <span>
                            {memory.source === "automatic"
                              ? t("common.automatic")
                              : memory.source === "agent"
                                ? t("memory.assistant")
                                : t("common.manual")}
                          </span>
                        </div>
                        <p>{memory.content}</p>
                        <div className="ochi-settings__source">
                          <time>
                            {new Date(
                              memory.updated_at ?? memory.created_at,
                            ).toLocaleDateString(getLocale(), {
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
                              {t("memory.sourceConversation")}
                              <ArrowUpRight size={13} />
                            </button>
                          )}
                        </div>
                        {memory.source_excerpt && (
                          <details className="ochi-settings__excerpt">
                            <summary>
                              {t("memory.sourceExcerpt")}
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
                          aria-label={t("memory.edit")}
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          className="icon-button danger"
                          onClick={() => void remove(memory.id)}
                          aria-label={t("memory.delete")}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </article>
                  ))}
                  {!filtered.length && (
                    <div className="ochi-settings__empty">{query || kind !== "all" || scope !== "all" ? t("memory.noResults") : t("memory.empty")}</div>
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
