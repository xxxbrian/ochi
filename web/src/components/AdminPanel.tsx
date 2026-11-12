import { t, useAdminI18n, type AdminMessageKey } from "../pages/admin/i18n";
import { Fragment, lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, Bug, Check, ChevronsUpDown, Container, Globe, History, Puzzle, Settings, Sparkles, Users, type LucideIcon } from "lucide-react";
import { UsersPage, SystemPage, WorkspacesPage, RunsPage } from "../pages/admin/SystemPages";
import { DebugPage } from "../pages/admin/RequestDiagnostics";
import { AdminSlotContext, Pill, SkeletonRows, type AdminSlots } from "../pages/admin/ui";
import { ActionMenu, MenuAction } from "./ui/Menu";
import { adminApi } from "../lib/api";
const ProvidersPage = lazy(() => import("../pages/admin/ProvidersPage"));
const SearchPage = lazy(() => import("../pages/admin/SearchPage"));
const PluginsPage = lazy(() => import("../pages/admin/PluginsPage"));

type Section = { id: string; title: string; icon: LucideIcon; group: string; desc: string };
/** Nav order and grouping follow the lab; `settings` keeps the existing /admin/settings route for the System page. */
function sections(): Section[] {
  const models = t("adminGroupModels"), org = t("adminGroupOrganization"), ops = t("adminGroupOperations");
  return [
    { id: "providers", title: t("modelProviders"), icon: Sparkles, group: models, desc: t("adminDesc.providers") },
    { id: "search", title: t("webSearch"), icon: Globe, group: models, desc: t("adminDesc.search") },
    { id: "plugins", title: t("plugins"), icon: Puzzle, group: models, desc: t("adminDesc.plugins") },
    { id: "users", title: t("users"), icon: Users, group: org, desc: t("adminDesc.users") },
    { id: "workspaces", title: t("workspaces"), icon: Container, group: org, desc: t("adminDesc.workspaces") },
    { id: "runs", title: t("runRecords"), icon: History, group: ops, desc: t("adminDesc.runs") },
    { id: "debug", title: t("requestDiagnostics"), icon: Bug, group: ops, desc: t("adminDesc.debug") },
    { id: "settings", title: t("system"), icon: Settings, group: ops, desc: t("adminDesc.system") },
  ];
}
const activeTab = (section: string) => (section === "skills" || section === "mcp" ? "plugins" : section);

export default function AdminPanel({ section, onNavigate, onBack, currentUserID }: {
  section: string;
  onNavigate: (path: string) => void;
  onBack: () => void;
  currentUserID: string;
}) {
  useAdminI18n();
  const list = sections();
  const active = activeTab(section);
  const current = list.find((item) => item.id === active) ?? list[0];
  const nav = useRef<HTMLElement>(null);
  const indicator = useRef<HTMLElement>(null);
  const [slots, setSlots] = useState<AdminSlots>({ actions: null, toolbar: null });
  const [build, setBuild] = useState<{ version: string; available: boolean } | null>(null);
  const placed = useRef(false);

  // The footer shows the running version; a failed lookup simply leaves it out.
  useEffect(() => {
    const controller = new AbortController();
    adminApi.updates(controller.signal)
      .then((state) => { if (!controller.signal.aborted) setBuild({ version: state.current.version, available: state.available }); })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  // The active-row indicator springs between rows. The first placement skips the transition so it does not fly in from the top.
  useLayoutEffect(() => {
    const element = nav.current, thumb = indicator.current;
    if (!element || !thumb) return;
    const place = (animate: boolean) => {
      const target = element.querySelector<HTMLElement>('[aria-current="page"]');
      if (!target) { thumb.style.opacity = "0"; return; }
      if (!animate) thumb.style.transition = "none";
      thumb.style.height = `${target.offsetHeight}px`;
      thumb.style.translate = `0 ${target.offsetTop}px`;
      thumb.style.opacity = "1";
      if (!animate) requestAnimationFrame(() => requestAnimationFrame(() => { thumb.style.transition = ""; }));
    };
    place(placed.current);
    placed.current = true;
    const observer = new ResizeObserver(() => place(false));
    element.querySelectorAll(".ochi-admin-nitem").forEach((item) => observer.observe(item));
    return () => observer.disconnect();
  }, [active, list.length]);

  let lastGroup = "";
  return (
    <div className="ochi-admin-root" data-sec={current.id}>
      <aside className="ochi-admin-nav">
        <div className="ochi-admin-brand"><img className="ochi-admin-mark" src="/favicon-48.png" alt="" /><div><b>Ochi</b><small>{t("adminConsole")}</small></div></div>
        <button type="button" className="ochi-admin-back" onClick={onBack}><ArrowLeft className="ic" />{t("backToChat")}</button>
        <nav className="ochi-admin-nlist" ref={nav} aria-label={t("adminNavigation")}>
          <i className="ochi-admin-nind" ref={indicator} aria-hidden="true" style={{ opacity: 0 }} />
          {list.map((item) => {
            const header = item.group !== lastGroup ? <div className="ochi-admin-ngroup" aria-hidden="true">{item.group}</div> : null;
            lastGroup = item.group;
            return (
              <Fragment key={item.id}>
                {header}
                <button type="button" className="ochi-admin-nitem" aria-current={item.id === current.id ? "page" : undefined}
                  onClick={() => onNavigate(`/admin/${item.id}`)}>
                  <item.icon className="ic" /><span>{item.title}</span>
                </button>
              </Fragment>
            );
          })}
        </nav>
        {build && (
          <footer className="ochi-admin-nfoot">
            <span className="mono" title={t("adminVersion")}>v{build.version.replace(/^v/, "")}</span>
            {build.available && <Pill tone="accent">{t("adminUpdateAvailable")}</Pill>}
          </footer>
        )}
      </aside>
      <main className="ochi-admin-main">
        <div className="ochi-admin-topbar">
          <button type="button" className="icon-btn" aria-label={t("backToChat")} onClick={onBack}><ArrowLeft className="ic" /></button>
          <ActionMenu label={t("adminSwitchSection")} className="ochi-admin-picker" align="start" side="bottom"
            trigger={<><current.icon className="ic" /><b>{current.title}</b><ChevronsUpDown className="ic" /></>}>
            {list.map((item) => (
              <MenuAction key={item.id} onClick={() => onNavigate(`/admin/${item.id}`)}>
                <item.icon className="ic" /><span>{item.title}</span>{item.id === current.id ? <Check className="ic tick" style={{ opacity: 1 }} /> : null}
              </MenuAction>
            ))}
          </ActionMenu>
        </div>
        <header className="ochi-admin-head">
          <div className="ochi-admin-head-t"><h1>{current.title}</h1><p>{current.desc}</p></div>
          <div className="ochi-admin-head-a" ref={(element) => { if (element !== slots.actions) setSlots((previous) => ({ ...previous, actions: element })); }} />
          <div className="ochi-admin-toolbar" ref={(element) => { if (element !== slots.toolbar) setSlots((previous) => ({ ...previous, toolbar: element })); }} />
        </header>
        <div className="ochi-admin-body ochi-admin-stagger" key={current.id}>
          <AdminSlotContext.Provider value={slots}>
            <Suspense fallback={<SkeletonRows rows={5} />}>
              {section === "search" ? <SearchPage />
                : section === "plugins" || section === "skills" || section === "mcp" ? <PluginsPage section={section} onNavigate={onNavigate} />
                : section === "users" ? <UsersPage currentUserID={currentUserID} />
                : section === "settings" ? <SystemPage />
                : section === "workspaces" ? <WorkspacesPage />
                : section === "runs" ? <RunsPage currentUserID={currentUserID} onNavigate={onNavigate} />
                : section === "debug" ? <DebugPage />
                : <ProvidersPage />}
            </Suspense>
          </AdminSlotContext.Provider>
        </div>
      </main>
    </div>
  );
}

export type { AdminMessageKey };
