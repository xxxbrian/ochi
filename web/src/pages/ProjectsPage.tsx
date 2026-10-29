import { t, useI18n, getLocale } from "../lib/i18n";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import { api } from "../lib/api";
import type { Project, Session } from "../lib/types";
import { Modal } from "../components/Modal";
import { MobileMenuButton } from "../components/Sidebar";
import { ActionMenu, MenuAction } from "../components/ui/Menu";
import { statusLabel } from "../lib/router";
import "./project.css";

export default function ProjectsPage({
  projectId,
  onNavigate,
  onRefresh,
  onMenu,
  renderComposer,
}: {
  projectId?: string;
  onNavigate: (path: string) => void;
  onRefresh: () => void;
  onMenu: () => void;
  renderComposer?: (projectId: string) => ReactNode;
}) {
  useI18n();
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [moreLoading, setMoreLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Partial<Project> | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const generation = useRef(0);
  const loadedProjectId = useRef<string | null>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const refresh = useCallback(async () => {
    const token = ++generation.current;
    const initial = loadedProjectId.current !== (projectId ?? "");
    setLoading(initial);
    setSearchLoading(!initial && Boolean(projectId));
    setMoreLoading(false);
    setError("");
    try {
      if (projectId) {
        const [value, page] = await Promise.all([
          api.project(projectId),
          debouncedQuery ? api.sessionsPage({ project_id: projectId, q: debouncedQuery }) : Promise.resolve(null),
        ]);
        const list = page ? page.items : value.sessions;
        if (token !== generation.current) return;
        setProject(value);
        setSessions(list);
        setCursor(page ? page.next_cursor : value.next_cursor);
        loadedProjectId.current = projectId;
      } else {
        const list = await api.projects();
        if (token === generation.current) {
          setProjects(list);
          loadedProjectId.current = "";
        }
      }
    } catch (reason) {
      if (token === generation.current)
        setError(reason instanceof Error ? reason.message : t("error.load"));
    } finally {
      if (token === generation.current) {
        setLoading(false);
        setSearchLoading(false);
      }
    }
  }, [projectId, debouncedQuery]);
  useEffect(() => {
    setQuery("");
    setDebouncedQuery("");
    setSearching(false);
  }, [projectId]);
  useEffect(() => {
    const delay = window.setTimeout(() => setDebouncedQuery(query.trim()), 180);
    return () => window.clearTimeout(delay);
  }, [query]);
  useEffect(() => {
    void refresh();
    return () => {
      generation.current += 1;
    };
  }, [refresh]);
  async function save() {
    if (!editing) return;
    setSaving(true);
    try {
      const value = await api.saveProject(editing);
      setEditing(null);
      onRefresh();
      onNavigate(`/projects/${value.id}`);
      if (value.id === projectId) void refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("error.save"));
    } finally {
      setSaving(false);
    }
  }
  return (
    <main className="workspace-page ochi-projects">
      <header className="chat-header ochi-projects__header">
        <div className="header-title">
          <MobileMenuButton onClick={onMenu} />
          {projectId && (
            <button
              className="ochi-projects__back"
              aria-label={t("projects.all")}
              onClick={() => onNavigate("/projects")}
            >
              <ArrowLeft size={18} />
              <span>{t("projects.title")}</span>
            </button>
          )}
          {!projectId && <h1>{t("projects.title")}</h1>}
        </div>
        {!projectId && <button
          className="secondary-button"
          onClick={() => setEditing({ name: "", instructions: "" })}
        >
          <Plus size={16} />
          {t("projects.create")}
        </button>}
        {projectId && project?.id === projectId && <ActionMenu trigger={<MoreHorizontal size={19} />} label={t("projects.manage")}>
          <MenuAction onClick={() => setEditing(project)}><Pencil size={16} />{t("projects.settings")}</MenuAction>
          <MenuAction danger onClick={() => setDeleting(project)}><Trash2 size={16} />{t("projects.delete")}</MenuAction>
        </ActionMenu>}
      </header>
      <div className="workspace-page-scroll">
        <div className="page-column ochi-projects__column">
          {error && <p className="form-error">{error}</p>}
          {loading ? (
            <div className="panel-loading">
              <LoaderCircle className="spin" size={22} />
            </div>
          ) : projectId && project ? (
            <>
              <div className="ochi-projects__intro">
                <FolderOpen size={25} />
                <div className="ochi-projects__intro-text">
                  <h1>{project.name}</h1>
                </div>
              </div>
              {renderComposer && <div ref={composerRef} className="ochi-projects__composer">{renderComposer(project.id)}</div>}
              {project.instructions && (
                <details className="ochi-projects__context">
                  <summary>
                    {t("projects.instructions")}
                    <ChevronDown size={14} />
                  </summary>
                  <div>
                    {project.instructions}
                  </div>
                </details>
              )}
              <div className="ochi-projects__sessions-heading">
                <h3>{t("chat.conversations")} <span>{project.session_count ?? sessions.length}</span></h3>
                <div className="ochi-projects__session-tools">
                  {searching ? <label className="ochi-projects__search">
                    <Search size={15} />
                    <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("search.conversations")} aria-label={t("projects.searchConversations")} autoFocus />
                    <button type="button" className="icon-button" onClick={() => { setQuery(""); setSearching(false); }} aria-label={t("common.closeSearch")}><X size={16} /></button>
                  </label> : <button className="icon-button" onClick={() => setSearching(true)} aria-label={t("projects.searchConversations")}><Search size={17} /></button>}
                  <button
                  className="icon-button"
                  title={t("chat.newConversation")}
                  aria-label={t("projects.newConversation")}
                  onClick={() => {
                    composerRef.current?.scrollIntoView({ block: "nearest" });
                    composerRef.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
                  }}
                >
                  <SquarePen size={18} />
                </button>
                </div>
              </div>
              <div className="ochi-projects__sessions" aria-busy={searchLoading}>
                {searchLoading && <span className="ochi-projects__search-loading"><LoaderCircle size={15} className="spin" /></span>}
                {sessions.map((session) => (
                  <button
                    key={session.id}
                    onClick={() => onNavigate(`/c/${session.id}`)}
                  >
                    <span>{session.title || t("chat.newConversation")}</span>
                    <small className="ochi-projects__session-date">
                      {session.run_status && ["queued", "running", "waiting_user", "waiting_resource", "cancelling"].includes(session.run_status)
                        ? statusLabel(session.run_status)
                        : new Date(session.updated_at).toLocaleDateString(getLocale(), { month: "short", day: "numeric" })}
                    </small>
                  </button>
                ))}
                {!sessions.length && !searchLoading && <div className="ochi-projects__empty">{debouncedQuery ? t("search.noConversations") : t("chat.empty")}</div>}
                {cursor && <button disabled={moreLoading || searchLoading} className="search-load-more" onClick={() => {
                  const token = generation.current;
                  setMoreLoading(true);
                  void api.sessionsPage({ cursor, project_id: project.id, q: debouncedQuery || undefined }).then((page) => {
                    if (token !== generation.current) return;
                    setSessions((current) => {
                      const seen = new Set(current.map((item) => item.id));
                      return [...current, ...page.items.filter((item) => !seen.has(item.id))];
                    });
                    setCursor(page.next_cursor);
                  }).catch((reason: Error) => { if (token === generation.current) setError(reason.message); })
                    .finally(() => { if (token === generation.current) setMoreLoading(false); });
                }}>{moreLoading ? <LoaderCircle size={15} className="spin" /> : t("sidebar.earlier")}</button>}
              </div>
            </>
          ) : (
            <>
              <div className="ochi-projects__list">
                {projects.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => onNavigate(`/projects/${item.id}`)}
                  >
                    <Folder size={20} />
                    <div>
                      <strong>{item.name}</strong>
                      <span>{t("chat.count", { count: item.session_count ?? 0 })}</span>
                    </div>
                    <ChevronRight size={17} />
                  </button>
                ))}
              </div>
              {!projects.length && (
                <div className="ochi-projects__empty">
                  <Folder size={26} />
                  <span>{t("projects.empty")}</span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {editing && (
        <Modal
          title={editing.id ? t("projects.edit") : t("projects.create")}
          size="small"
          onClose={() => setEditing(null)}
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
                form="project-editor"
                className="primary-button"
                disabled={saving || !editing.name?.trim()}
              >
                {t("common.save")}
              </button>
            </div>
          }
        >
          <form
            id="project-editor"
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
              <span>{t("projects.instructions")}</span>
              <textarea
                rows={4}
                value={editing.instructions ?? ""}
                onChange={(event) =>
                  setEditing({ ...editing, instructions: event.target.value })
                }
              />
            </label>
            {error && <p className="form-error">{error}</p>}
          </form>
        </Modal>
      )}
      {deleting && (
        <Modal
          title={t("projects.deleteConfirm")}
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
                disabled={saving}
                onClick={() => {
                  setSaving(true);
                  void api
                    .deleteProject(deleting.id)
                    .then(() => {
                      setDeleting(null);
                      onRefresh();
                      onNavigate("/projects");
                      void refresh();
                    })
                    .catch((reason: Error) => setError(reason.message))
                    .finally(() => setSaving(false));
                }}
              >
                {t("common.delete")}
              </button>
            </div>
          }
        >
          <p>{deleting.name}</p>
        </Modal>
      )}
    </main>
  );
}
