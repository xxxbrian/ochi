import { t, useI18n } from "../lib/i18n";
import { lazy, Suspense, useEffect, useState } from "react";
import {
  ChevronRight,
  Clock3,
  Folder,
  LogOut,
  LoaderCircle,
  MoreHorizontal,
  Monitor,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Search,
  Settings,
  Shield,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import type { Project, Session, User } from "../lib/types";
import { Modal } from "./Modal";
import { ActionMenu, MenuAction } from "./ui/Menu";
import { isActiveStatus } from "../lib/api";
import { statusLabel } from "../lib/router";
import "./sidebar.css";
const SessionSearch = lazy(() => import("./SessionSearch").then((module) => ({ default: module.SessionSearch })));

type Props = {
  sessions: Session[];
  selectedId: string | null;
  user: User;
  open: boolean;
  collapsed: boolean;
  disabled: boolean;
  onClose: () => void;
  onCollapse: () => void;
  onCreate: () => void;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onLogout: () => void;
  onSettings: () => void;
  onAdmin: () => void;
  onComputer: () => void;
  onSchedules: () => void;
  projects?: Project[];
  selectedProjectId?: string;
  onProjects?: () => void;
  onProject?: (id: string) => void;
  moreAvailable?: boolean;
  moreLoading?: boolean;
  onLoadMore?: () => void;
};

export function Sidebar({
  sessions,
  selectedId,
  user,
  open,
  collapsed,
  disabled,
  onClose,
  onCollapse,
  onCreate,
  onSelect,
  onRename,
  onDelete,
  onLogout,
  onSettings,
  onAdmin,
  onComputer,
  onSchedules,
  projects = [],
  selectedProjectId,
  onProjects,
  onProject,
  moreAvailable,
  moreLoading,
  onLoadMore,
}: Props) {
  useI18n();
  const [searching, setSearching] = useState(false);
  const [editing, setEditing] = useState<Session | null>(null);
  const [deleting, setDeleting] = useState<Session | null>(null);
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearching((value) => !value);
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  return (
    <>
      <div
        className={`sidebar-backdrop ${open ? "is-open" : ""}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className={`sidebar ochi-sidebar ${open ? "is-open" : ""} ${collapsed ? "is-collapsed" : ""}`}
        aria-label={t("sidebar.conversationList")}
      >
        <div className="sidebar-top">
          <span className="sidebar-brand">Ochi</span>
          <button
            className="icon-button sidebar-collapse"
            onClick={onCollapse}
            aria-label={collapsed ? t("sidebar.expand") : t("sidebar.collapse")}
          >
            {collapsed ? (
              <PanelLeftOpen size={20} />
            ) : (
              <PanelLeftClose size={20} />
            )}
          </button>
          <button
            className="icon-button close-sidebar"
            aria-label={t("sidebar.close")}
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        <button
          className="sidebar-nav new-session"
          onClick={onCreate}
          disabled={disabled}
          title={t("chat.newConversation")}
        >
          <SquarePen size={19} />
          <span>{t("chat.newConversation")}</span>
        </button>
        <button
          className="sidebar-nav"
          onClick={() => setSearching(true)}
          title={t("search.conversations")}
        >
          <Search size={19} />
          <span>{t("search.conversations")}</span>
        </button>
        <button className="sidebar-nav" onClick={() => { onClose(); onComputer(); }} title={t("computer.title")}>
          <Monitor size={19} />
          <span>{t("computer.title")}</span>
        </button>
        <button className="sidebar-nav" onClick={onSchedules} title={t("tasks.title")}>
          <Clock3 size={19} />
          <span>{t("tasks.title")}</span>
        </button>
        <button className="sidebar-nav ochi-sidebar__projects-shortcut" onClick={() => { onClose(); onProjects?.(); }} title={t("projects.title")}>
          <Folder size={19} />
          <span>{t("projects.title")}</span>
        </button>
        <nav className="session-list" aria-label={t("chat.conversations")}>
          <div className="ochi-sidebar__project-section">
            <button className="ochi-sidebar__section-heading" onClick={() => { onClose(); onProjects?.(); }}>
              <span>{t("projects.title")}</span>
              <ChevronRight size={13} />
            </button>
            {projects.map((project) => (
              <button
                key={project.id}
                className={`ochi-sidebar__project-link ${selectedProjectId === project.id ? "selected" : ""}`}
                onClick={() => { onClose(); onProject?.(project.id); }}
                title={project.name}
                aria-current={selectedProjectId === project.id ? "page" : undefined}
              >
                <Folder size={17} />
                <span>{project.name}</span>
              </button>
            ))}
          </div>
          <div className="rail-section-label">{t("sidebar.recent")}</div>
          {sessions.map((session) => (
            <div
              className={`session-item ${selectedId === session.id ? "selected" : ""}`}
              key={session.id}
            >
              <button
                className="session-row"
                onClick={() => {
                  onSelect(session.id);
                }}
                disabled={disabled}
                aria-current={selectedId === session.id ? "page" : undefined}
              >
                {session.title || t("chat.newConversation")}
              </button>
              {isActiveStatus(session.run_status) && (
                <span
                  className={`session-activity ${session.run_status === "queued" ? "queued" : ""}`}
                  title={statusLabel(session.run_status)}
                />
              )}
              <div className="session-more">
                <ActionMenu
                  trigger={<MoreHorizontal size={17} />}
                  label={t("chat.manage", { name: session.title || t("chat.newConversation") })}
                >
                  <MenuAction
                    onClick={() => {
                      setEditing(session);
                      setTitle(session.title);
                    }}
                  >
                    <Pencil size={15} />
                    {t("common.rename")}
                  </MenuAction>
                  <MenuAction danger onClick={() => setDeleting(session)}>
                    <Trash2 size={15} />
                    {t("common.delete")}
                  </MenuAction>
                </ActionMenu>
              </div>
            </div>
          ))}
          {moreAvailable && <button className="sidebar-nav session-list-more" disabled={moreLoading} onClick={onLoadMore}>
            {moreLoading ? <LoaderCircle size={15} className="spin" /> : <Clock3 size={15} />}
            <span>{moreLoading ? t("status.loading") : t("sidebar.earlier")}</span>
          </button>}
        </nav>
        <div className="sidebar-bottom">
          <ActionMenu className="sidebar-account" popupClassName="action-menu-account" align="start" label={t("sidebar.accountMenu")} side="top" trigger={<>
            <span className="account-avatar">{(user.display_name || user.username).slice(0, 1).toUpperCase()}</span>
            <span className="account-name">{user.display_name || user.username}</span>
            <MoreHorizontal size={17} />
          </>}>
            <div className="ochi-account-menu__identity">{user.display_name || user.username}</div>
            <MenuAction onClick={() => { onClose(); onSettings(); }}><Settings size={16} />{t("settings.title")}</MenuAction>
            {user.role === "admin" && <MenuAction onClick={() => { onClose(); onAdmin(); }}><Shield size={16} />{t("sidebar.admin")}</MenuAction>}
            <div className="ochi-account-menu__divider" role="separator" />
            <MenuAction onClick={onLogout}><LogOut size={16} />{t("login.signOut")}</MenuAction>
          </ActionMenu>
        </div>
      </aside>
      {searching && <Suspense fallback={null}><SessionSearch onClose={() => setSearching(false)} onSelect={onSelect} /></Suspense>}
      {editing && (
        <Modal
          title={t("chat.rename")}
          size="small"
          onClose={() => setEditing(null)}
          footer={
            <>
              <button type="button" className="secondary-button" onClick={() => setEditing(null)}>
                {t("common.cancel")}
              </button>
              <button className="primary-button" type="submit" form="rename-session" disabled={saving || !title.trim()}>
                {t("common.save")}
              </button>
            </>
          }
        >
          <form
            id="rename-session"
            onSubmit={(event) => {
              event.preventDefault();
              setSaving(true);
              void onRename(editing.id, title)
                .then(() => setEditing(null))
                .finally(() => setSaving(false));
            }}
          >
            <input
              className="field-input"
              autoFocus
              aria-label={t("chat.name")}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </form>
        </Modal>
      )}
      {deleting && (
        <Modal title={t("chat.deleteConfirm")} size="small" onClose={() => setDeleting(null)} footer={
          <>
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
                void onDelete(deleting.id)
                  .then(() => setDeleting(null))
                  .finally(() => setSaving(false));
              }}
            >
              {t("common.delete")}
            </button>
          </>
        }>
          <p className="dialog-session-title">{deleting.title}</p>
        </Modal>
      )}
    </>
  );
}

export function MobileMenuButton({ onClick }: { onClick: () => void }) {
  useI18n();
  return (
    <button
      className="icon-button mobile-menu"
      aria-label={t("sidebar.open")}
      onClick={onClick}
    >
      <PanelLeftOpen size={21} />
    </button>
  );
}
