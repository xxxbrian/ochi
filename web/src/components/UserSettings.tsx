import { t, useI18n, type LanguagePreference } from "../lib/i18n";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Brain, Check, ChevronLeft, ChevronRight, Cpu, Database, Palette, Puzzle, SlidersHorizontal, User as UserIcon, type LucideIcon } from "lucide-react";
import type { Project, User } from "../lib/types";
import { Modal } from "./Modal";
import { AccountTab } from "./settings/AccountTab";
import { AppearanceTab } from "./settings/AppearanceTab";
import { DataTab } from "./settings/DataTab";
import { GeneralTab } from "./settings/GeneralTab";
import { MemoryTab } from "./settings/MemoryTab";
import { ModelsTab } from "./settings/ModelsTab";
import { PluginsTab } from "./settings/PluginsTab";
import { Avatar, SavedContext } from "./settings/ui";
import "./settings/settings.css";

type Tab = "general" | "appearance" | "models" | "memory" | "plugins" | "data" | "account";
const TAB_ORDER: Tab[] = ["general", "appearance", "models", "memory", "plugins", "data", "account"];
const TAB_SWAP_MS = 130;
const SAVED_MS = 1500;

export default function UserSettings({
  onClose,
  projects = [],
  onNavigate,
  onLanguage,
  user,
  onLogout,
}: {
  onClose: () => void;
  projects?: Project[];
  onNavigate?: (path: string) => void;
  onLanguage: (language: LanguagePreference) => Promise<void>;
  user: User;
  onLogout: () => void;
}) {
  useI18n();
  const [tab, setTab] = useState<Tab>("general");
  const [shown, setShown] = useState<Tab>("general");
  const [leaving, setLeaving] = useState(false);
  const [dir, setDir] = useState(1);
  // Narrow containers show the category list first and drill into a page, like a native settings app.
  const [view, setView] = useState<"nav" | "content">(() => (window.matchMedia("(max-width: 700px)").matches ? "nav" : "content"));
  const [savedVisible, setSavedVisible] = useState(false);
  const [flash, setFlash] = useState("");
  const [scrolled, setScrolled] = useState(false);
  const swapTimer = useRef(0);
  const savedTimer = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  // The dialog content mounts through a portal after the first render, so the tab list is tracked as state.
  const [tabs, setTabs] = useState<HTMLDivElement | null>(null);
  useEffect(() => () => { window.clearTimeout(swapTimer.current); window.clearTimeout(savedTimer.current); }, []);

  // Every successful change confirms itself with the "Saved" chip and a flash on its row.
  const saved = useRef((row = "") => {
    setSavedVisible(true);
    setFlash(row);
    window.clearTimeout(savedTimer.current);
    savedTimer.current = window.setTimeout(() => { setSavedVisible(false); setFlash(""); }, SAVED_MS);
  }).current;

  function selectTab(next: Tab) {
    setView("content");
    if (next === tab) return;
    setDir(TAB_ORDER.indexOf(next) > TAB_ORDER.indexOf(tab) ? 1 : -1);
    setTab(next);
    setLeaving(true);
    window.clearTimeout(swapTimer.current);
    swapTimer.current = window.setTimeout(() => {
      setShown(next);
      setLeaving(false);
      scroller.current?.scrollTo({ top: 0 });
    }, TAB_SWAP_MS);
  }
  // The pill slides to the current category; measuring keeps it right in every language.
  useLayoutEffect(() => {
    const element = tabs;
    if (!element) return;
    const place = () => {
      const target = element.querySelector<HTMLElement>('button[aria-current="true"]');
      if (!target) return;
      element.style.setProperty("--py", `${target.offsetTop}px`);
      element.style.setProperty("--ph", `${target.offsetHeight}px`);
      element.dataset.ready = "true";
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    return () => observer.disconnect();
  }, [tab, tabs]);

  const categories: { id: Tab; label: string; desc: string; icon: LucideIcon }[] = [
    { id: "general", label: t("settings.general"), desc: t("settings.desc.general"), icon: SlidersHorizontal },
    { id: "appearance", label: t("settings.appearance"), desc: t("settings.desc.appearance"), icon: Palette },
    { id: "models", label: t("settings.models"), desc: t("settings.desc.models"), icon: Cpu },
    { id: "memory", label: t("memory.title"), desc: t("settings.desc.memory"), icon: Brain },
    { id: "plugins", label: t("plugins.title"), desc: t("settings.desc.plugins"), icon: Puzzle },
    { id: "data", label: t("settings.data"), desc: t("settings.desc.data"), icon: Database },
    { id: "account", label: t("settings.account"), desc: t("settings.desc.account"), icon: UserIcon },
  ];
  const current = categories.find((item) => item.id === shown) ?? categories[0];
  const name = user.display_name || user.username;
  const role = t(user.role === "admin" ? "sidebar.role.admin" : "sidebar.role.user");
  const content =
    shown === "general" ? <GeneralTab onLanguage={onLanguage} />
    : shown === "appearance" ? <AppearanceTab />
    : shown === "models" ? <ModelsTab />
    : shown === "memory" ? <MemoryTab accountId={user.id} projects={projects} onClose={onClose} onNavigate={onNavigate} />
    : shown === "plugins" ? <PluginsTab />
    : shown === "data" ? <DataTab />
    : <AccountTab user={user} onLogout={onLogout} />;

  return (
    <Modal title={t("settings.title")} onClose={onClose} size="large" headerless className="st-modal" bodyClassName="st-modal-body">
      <SavedContext.Provider value={{ flash, saved }}>
        <div className="st-shell" data-tab={tab} data-view={view} data-scrolled={scrolled} style={{ "--dir": dir } as CSSProperties}>
          <nav className="st-nav" aria-label={t("settings.categories")}>
            <h2 className="st-nav-t" aria-hidden="true">{t("settings.title")}</h2>
            <div className="st-tabs" ref={setTabs} role="tablist" aria-orientation="vertical">
              <span className="st-pill" aria-hidden="true" />
              {categories.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  className="st-tab"
                  aria-selected={tab === item.id}
                  aria-current={tab === item.id}
                  aria-controls={`settings-${item.id}`}
                  onClick={() => selectTab(item.id)}
                >
                  <span className="st-ti"><item.icon size={16} /></span>
                  <span>{item.label}</span>
                  <ChevronRight size={14} className="st-chev" aria-hidden="true" />
                </button>
              ))}
            </div>
            <div className="st-user">
              <Avatar user={user} />
              <span className="st-rt"><b>{name}</b><small>{role}</small></span>
            </div>
          </nav>
          <section className="st-mn">
            <header className="st-hd">
              <button type="button" className="icon-btn st-cback" aria-label={t("settings.back")} onClick={() => setView("nav")}><ChevronLeft size={18} /></button>
              <div className="st-ttl" data-leaving={leaving}>
                <h2 className="st-ttx">{current.label}</h2>
                <p className="st-desc">{current.desc}</p>
              </div>
            </header>
            <div className="st-scroll" ref={scroller} onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 4)}>
              <div className="st-col">
                <div className="st-bd" data-leaving={leaving} role="tabpanel" id={`settings-${shown}`} aria-label={current.label}>{content}</div>
              </div>
            </div>
            <span className="st-saved" data-on={savedVisible} aria-hidden="true"><Check size={13} />{t("settings.saved")}</span>
            <span className="sr-only" role="status">{savedVisible ? t("settings.saved") : ""}</span>
          </section>
        </div>
      </SavedContext.Provider>
    </Modal>
  );
}
