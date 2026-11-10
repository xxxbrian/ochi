import { t, useI18n } from "../lib/i18n";
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ContextMenu } from "@base-ui/react/context-menu";
import {
  CalendarClock,
  ChevronsUpDown,
  Download,
  Folder,
  Languages,
  LogOut,
  Monitor,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Pin,
  PinOff,
  Search,
  Settings,
  ShieldCheck,
  SquarePen,
  Trash2,
} from "lucide-react";
import type { Session, User } from "../lib/types";
import { Modal } from "./Modal";
import { ActionMenu, MenuAction, MenuLabel, MenuSeparator } from "./ui/Menu";
import { toast } from "./ui/Toast";
import { isActiveStatus } from "../lib/api";
import { statusLabel } from "../lib/router";
import { groupSessions } from "../lib/sessionGroups";
import { exportTranscript } from "../lib/exportTranscript";
import "./sidebar.css";
const SessionSearch = lazy(() => import("./SessionSearch").then((module) => ({ default: module.SessionSearch })));

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const modKey = isMac ? "⌘" : "Ctrl";

type Props = {
  sessions: Session[];
  selectedId: string | null;
  user: User;
  /** Expanded, or collapsed to the icon rail (desktop) / hidden drawer (compact). */
  expanded: boolean;
  compact: boolean;
  disabled: boolean;
  pinned: string[];
  onToggle: () => void;
  onPin: (id: string) => void;
  onCreate: () => void;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onLogout: () => void;
  onSettings: () => void;
  onAdmin: () => void;
  onComputer: () => void;
  /** The new-conversation view is showing. */
  newActive?: boolean;
  /** The Computer dock is open. */
  computerActive?: boolean;
  onSchedules: () => void;
  onProjects: () => void;
  projectsActive?: boolean;
  tasksActive?: boolean;
  moreAvailable?: boolean;
  moreLoading?: boolean;
  onLoadMore?: () => void;
  searchOpen: boolean;
  onSearchOpenChange: (open: boolean) => void;
  searchCommands: PaletteCommand[];
};
export type PaletteCommand = { id: string; icon: ReactNode; label: string; hint?: string; run: () => void };

function SessionStatus({ session }: { session: Session }) {
  const status = session.run_status;
  if (!isActiveStatus(status)) return null;
  const label = statusLabel(status);
  if (status === "queued" || status === "waiting_resource") return <span className="s-status" title={label}><span className="dot" data-tone="accent" style={{ width: 6, height: 6 }} /></span>;
  if (status === "waiting_user") return <span className="s-status" title={label}><span className="dot" data-tone="warn" style={{ width: 6, height: 6 }} /></span>;
  return <span className="s-status s-wave" title={label} role="status" aria-label={label}><i /><i /><i /></span>;
}

function SessionMenuItems({ pinned, onRename, onPin, onExport, onDelete }: {
  pinned: boolean; onRename: () => void; onPin: () => void; onExport: () => void; onDelete: () => void;
}) {
  return <>
    <MenuAction onClick={onRename}><Pencil className="ic" />{t("common.rename")}</MenuAction>
    <MenuAction onClick={onPin}>{pinned ? <PinOff className="ic" /> : <Pin className="ic" />}{pinned ? t("sidebar.unpin") : t("sidebar.pin")}</MenuAction>
    <MenuAction onClick={onExport}><Download className="ic" />{t("sidebar.export")}</MenuAction>
    <MenuSeparator />
    <MenuAction danger onClick={onDelete}><Trash2 className="ic" />{t("common.delete")}</MenuAction>
  </>;
}

const WIDTH_KEY = "assistant.sidebar.w.v1";
const WIDTH_MIN = 220;
const WIDTH_MAX = 340;
const clampWidth = (value: number) => Math.round(Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, value)));
function storedWidth(): number | null {
  try { const raw = Number(localStorage.getItem(WIDTH_KEY)); return Number.isFinite(raw) && raw > 0 ? clampWidth(raw) : null; } catch { return null; }
}

/** Drag/keyboard separator: writes --sidebar-w on the shell (no React re-render while dragging) and persists the result. */
function ResizeHandle({ onDragging }: { onDragging: (value: boolean) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const shell = () => el.current?.closest<HTMLElement>(".app-shell") ?? null;
  const [width, setWidth] = useState(() => storedWidth() ?? 264);
  const start = useRef<{ x: number; w: number } | null>(null);
  const apply = (value: number, persist: boolean) => {
    const next = clampWidth(value);
    shell()?.style.setProperty("--sidebar-w", `${next}px`);
    setWidth(next);
    if (persist) try { localStorage.setItem(WIDTH_KEY, String(next)); } catch { /* storage unavailable */ }
    return next;
  };
  const reset = () => {
    shell()?.style.removeProperty("--sidebar-w");
    const base = shell() ? parseFloat(getComputedStyle(shell()!).getPropertyValue("--sidebar-w")) : 264;
    setWidth(Number.isFinite(base) ? base : 264);
    try { localStorage.removeItem(WIDTH_KEY); } catch { /* storage unavailable */ }
  };
  const down = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = { x: event.clientX, w: width };
    onDragging(true);
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (start.current) apply(start.current.w + (event.clientX - start.current.x) * (document.dir === "rtl" ? -1 : 1), false);
  };
  const up = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    start.current = null;
    onDragging(false);
    apply(width, true);
  };
  return (
    <div
      ref={el}
      className="sb-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label={t("sidebar.resize")}
      aria-valuemin={WIDTH_MIN}
      aria-valuemax={WIDTH_MAX}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={reset}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 48 : 16;
        if (event.key === "ArrowLeft") { event.preventDefault(); apply(width - step, true); }
        else if (event.key === "ArrowRight") { event.preventDefault(); apply(width + step, true); }
        else if (event.key === "Home") { event.preventDefault(); apply(WIDTH_MIN, true); }
        else if (event.key === "End") { event.preventDefault(); apply(WIDTH_MAX, true); }
        else if (event.key === "Enter") { event.preventDefault(); reset(); }
      }}
    />
  );
}

const NAV_ORDER = ["new", "search", "projects", "computer", "tasks"] as const;

export function Sidebar(props: Props) {
  const {
    sessions, selectedId, user, expanded, compact, disabled, pinned, onToggle, onPin, onCreate, onSelect, onRename, onDelete, onLogout,
    onSettings, onAdmin, onComputer, newActive, computerActive, onSchedules, onProjects, projectsActive, tasksActive, moreAvailable, moreLoading, onLoadMore,
    searchOpen, onSearchOpenChange, searchCommands,
  } = props;
  useI18n();
  const rail = !compact && !expanded;
  const aside = useRef<HTMLElement>(null);
  const [dragging, setDragging] = useState(false);
  useLayoutEffect(() => {
    const stored = storedWidth();
    if (stored) aside.current?.closest<HTMLElement>(".app-shell")?.style.setProperty("--sidebar-w", `${stored}px`);
  }, []);
  const navActive = searchOpen ? "search" : computerActive ? "computer" : projectsActive ? "projects" : tasksActive ? "tasks" : newActive ? "new" : null;
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Session | null>(null);
  const [saving, setSaving] = useState(false);
  const pinnedSet = useMemo(() => new Set(pinned), [pinned]);
  const pinnedSessions = useMemo(() => pinned.map((id) => sessions.find((item) => item.id === id)).filter((item): item is Session => Boolean(item)), [pinned, sessions]);
  const groups = useMemo(() => groupSessions(sessions.filter((item) => !pinnedSet.has(item.id))), [sessions, pinnedSet]);
  const groupLabel = { today: t("sidebar.group.today"), yesterday: t("sidebar.group.yesterday"), week: t("sidebar.group.week"), older: t("sidebar.group.older") };
  const name = user.display_name || user.username;

  async function exportSession(session: Session) {
    try {
      await exportTranscript(session.id, session.title || t("chat.newConversation"));
      toast(t("sidebar.exported"), { icon: "check" });
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : t("sidebar.exportFailed"), { icon: "info" });
    }
  }
  function row(session: Session) {
    const active = selectedId === session.id;
    const isPinned = pinnedSet.has(session.id);
    const items = (
      <SessionMenuItems
        pinned={isPinned}
        onRename={() => setRenaming(session.id)}
        onPin={() => { onPin(session.id); toast(isPinned ? t("sidebar.unpinned") : t("sidebar.pinnedToast"), { icon: "check" }); }}
        onExport={() => void exportSession(session)}
        onDelete={() => setDeleting(session)}
      />
    );
    const open = (event: MouseEvent<HTMLElement>) => {
      // Menus render in portals, but React still bubbles their clicks here.
      if (!event.currentTarget.contains(event.target as Node) || (event.target as Element).closest(".s-more, .s-rename")) return;
      if (!disabled && renaming !== session.id) onSelect(session.id);
    };
    const keys = (event: KeyboardEvent) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (!disabled && renaming !== session.id) onSelect(session.id); }
    };
    return (
      <ContextMenu.Root key={session.id}>
        <ContextMenu.Trigger
          className="s-item"
          data-id={session.id}
          data-active={active}
          role="button"
          tabIndex={0}
          aria-current={active ? "page" : undefined}
          onClick={open}
          onKeyDown={keys}
        >
          {isPinned && <Pin className="s-pin" aria-hidden="true" />}
          {renaming === session.id ? (
            <RenameField
              initial={session.title}
              onDone={(value) => {
                setRenaming(null);
                if (value && value !== session.title) void onRename(session.id, value);
              }}
            />
          ) : (
            <span className="s-title">{session.title || t("chat.newConversation")}</span>
          )}
          <SessionStatus session={session} />
          <ActionMenu
            className="s-more"
            align="start"
            label={t("chat.manage", { name: session.title || t("chat.newConversation") })}
            trigger={<MoreHorizontal className="ic" />}
          >
            {items}
          </ActionMenu>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Positioner className="pop-positioner" sideOffset={4} collisionPadding={8}>
            <ContextMenu.Popup className="pop"><div className="menu">{contextItems(session, isPinned)}</div></ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    );
  }
  function contextItems(session: Session, isPinned: boolean) {
    return <>
      <ContextMenu.Item className="menu-item" onClick={() => setRenaming(session.id)}><Pencil className="ic" />{t("common.rename")}</ContextMenu.Item>
      <ContextMenu.Item className="menu-item" onClick={() => onPin(session.id)}>{isPinned ? <PinOff className="ic" /> : <Pin className="ic" />}{isPinned ? t("sidebar.unpin") : t("sidebar.pin")}</ContextMenu.Item>
      <ContextMenu.Item className="menu-item" onClick={() => void exportSession(session)}><Download className="ic" />{t("sidebar.export")}</ContextMenu.Item>
      <div className="menu-sep" role="separator" />
      <ContextMenu.Item className="menu-item danger" onClick={() => setDeleting(session)}><Trash2 className="ic" />{t("common.delete")}</ContextMenu.Item>
    </>;
  }

  return (
    <>
      <aside ref={aside} className="app-sidebar" data-dragging={dragging || undefined} aria-label={t("sidebar.conversationList")} inert={compact && !expanded ? true : undefined}>
        <div className="sb-in">
          <div className="sb-top">
            <div className="brand-mark"><img src="/favicon-48.png" alt="" /><span>Ochi</span></div>
            <button className="icon-btn sb-toggle" onClick={onToggle} aria-label={expanded ? t("sidebar.collapse") : t("sidebar.expand")} title={rail ? t("sidebar.expand") : undefined}>
              <PanelLeft className="ic" />
            </button>
          </div>
          <nav className="sb-nav" style={{ "--i": navActive ? NAV_ORDER.indexOf(navActive) : 0 } as CSSProperties}>
            <span className="sb-pill" data-on={navActive ? true : undefined} aria-hidden="true" />
            <button className="sb-link primary" data-active={navActive === "new" || undefined} onClick={onCreate} disabled={disabled} title={rail ? t("chat.newConversation") : undefined}>
              <SquarePen className="ic" /><span>{t("chat.newConversation")}</span>
            </button>
            <button className="sb-link" data-active={navActive === "search" || undefined} onClick={() => onSearchOpenChange(true)} title={rail ? t("search.conversations") : undefined}>
              <Search className="ic" /><span>{t("sidebar.search")}</span><kbd aria-hidden="true">{modKey}K</kbd>
            </button>
            <button className="sb-link" data-active={navActive === "projects" || undefined} onClick={onProjects} title={rail ? t("projects.title") : undefined}>
              <Folder className="ic" /><span>{t("projects.title")}</span>
            </button>
            <button className="sb-link" data-active={navActive === "computer" || undefined} aria-pressed={computerActive || undefined} onClick={onComputer} title={rail ? t("computer.title") : undefined}>
              <Monitor className="ic" /><span>{t("computer.title")}</span>
            </button>
            <button className="sb-link" data-active={navActive === "tasks" || undefined} onClick={onSchedules} title={rail ? t("tasks.title") : undefined}>
              <CalendarClock className="ic" /><span>{t("tasks.title")}</span>
            </button>
          </nav>
          <nav className="sb-scroll" aria-label={t("chat.conversations")} inert={rail ? true : undefined}>
            {pinnedSessions.length > 0 && (
              <section aria-label={t("sidebar.pinned")}>
                <div className="sb-label"><Pin className="ic" style={{ width: 11, height: 11 }} />{t("sidebar.pinned")}</div>
                {pinnedSessions.map(row)}
              </section>
            )}
            {groups.map((group) => (
              <section key={group.key} aria-label={groupLabel[group.key]}>
                <div className="sb-label">{groupLabel[group.key]}</div>
                {group.items.map(row)}
              </section>
            ))}
            {moreAvailable && (
              <button className="sb-link sb-more" disabled={moreLoading} onClick={onLoadMore}>
                {moreLoading ? <span className="loading-dots">{t("status.loading")}<i>.</i><i>.</i><i>.</i></span> : <span>{t("sidebar.earlier")}</span>}
              </button>
            )}
          </nav>
          <div className="sb-spacer" />
          <div className="sb-foot">
            <ActionMenu
              className="account"
              popupClassName="pop-account"
              align="start"
              side="top"
              label={t("sidebar.accountMenu")}
              trigger={<>
                <span className="avatar">{name.slice(0, 1).toUpperCase()}</span>
                <span className="account-text">
                  <b>{name}</b>
                  <span>{t(user.role === "admin" ? "sidebar.role.admin" : "sidebar.role.user")}</span>
                </span>
                <ChevronsUpDown className="ic" />
              </>}
            >
              <MenuLabel>{user.username}</MenuLabel>
              <MenuAction onClick={onSettings}><Settings className="ic" />{t("settings.title")}</MenuAction>
              {user.role === "admin" && <MenuAction onClick={onAdmin}><ShieldCheck className="ic" />{t("sidebar.admin")}</MenuAction>}
              <MenuAction onClick={onSettings}><Languages className="ic" />{t("settings.language")}</MenuAction>
              <MenuSeparator />
              <MenuAction onClick={onLogout}><LogOut className="ic" />{t("login.signOut")}</MenuAction>
            </ActionMenu>
          </div>
        </div>
        {!compact && expanded && <ResizeHandle onDragging={setDragging} />}
      </aside>
      {searchOpen && (
        <Suspense fallback={null}>
          <SessionSearch onClose={() => onSearchOpenChange(false)} onSelect={onSelect} commands={searchCommands} />
        </Suspense>
      )}
      {deleting && (
        <Modal
          title={t("chat.deleteConfirm")}
          size="small"
          onClose={() => setDeleting(null)}
          footer={<>
            <button className="btn secondary" onClick={() => setDeleting(null)}>{t("common.cancel")}</button>
            <button
              className="btn danger"
              disabled={saving}
              onClick={() => {
                setSaving(true);
                void onDelete(deleting.id).then(() => setDeleting(null)).finally(() => setSaving(false));
              }}
            >
              {t("common.delete")}
            </button>
          </>}
        >
          <p className="dialog-body">{t("sidebar.deleteBody", { title: deleting.title || t("chat.newConversation") })}</p>
        </Modal>
      )}
    </>
  );
}

function RenameField({ initial, onDone }: { initial: string; onDone: (value: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    onDone(save ? (ref.current?.value.trim() ?? "") : "");
  };
  return (
    <input
      ref={ref}
      className="s-rename"
      defaultValue={initial}
      aria-label={t("chat.name")}
      maxLength={200}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter" && !event.nativeEvent.isComposing) finish(true);
        if (event.key === "Escape") finish(false);
      }}
      onBlur={() => finish(true)}
    />
  );
}

/** Opens the drawer on compact layouts; hidden whenever the sidebar is already on screen. */
export function MobileMenuButton({ onClick }: { onClick: () => void }) {
  useI18n();
  return (
    <button className="icon-btn mobile-menu" aria-label={t("sidebar.open")} onClick={onClick}>
      <PanelLeft className="ic" />
    </button>
  );
}
