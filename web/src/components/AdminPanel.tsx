import { t, useAdminI18n } from "../pages/admin/i18n";
import { lazy, Suspense } from "react";
import {
  Activity,
  ArrowLeft,
  Bug,
  Cpu,
  LoaderCircle,
  Plug,
  Puzzle,
  Search,
  Settings2,
  Users,
} from "lucide-react";
import {
  UsersPage,
  SystemPage,
  WorkspacesPage,
  RunsPage,
} from "../pages/admin/SystemPages";
import { DebugPage } from "../pages/admin/RequestDiagnostics";
const ProvidersPage = lazy(() => import("../pages/admin/ProvidersPage"));
const SearchPage = lazy(() => import("../pages/admin/SearchPage"));
const PluginsPage = lazy(() => import("../pages/admin/PluginsPage"));
function adminTabs() { return [
  { id: "providers", title: t("modelProviders"), icon: Plug },
  { id: "search", title: t("webSearch"), icon: Search },
  { id: "plugins", title: t("plugins"), icon: Puzzle },
  { id: "users", title: t("users"), icon: Users },
  { id: "workspaces", title: t("workspaces"), icon: Cpu },
  { id: "runs", title: t("runRecords"), icon: Activity },
  { id: "debug", title: t("requestDiagnostics"), icon: Bug },
  { id: "settings", title: t("system"), icon: Settings2 },
]; }
export default function AdminPanel({
  section,
  onNavigate,
  onBack,
  currentUserID,
}: {
  section: string;
  onNavigate: (path: string) => void;
  onBack: () => void;
  currentUserID: string;
}) {
  useAdminI18n();
  return (
    <main className="admin-app">
      <aside className="admin-sidebar">
        <header>
          <button
            className="icon-button"
            onClick={onBack}
            aria-label={t("backToChat")}
          >
            <ArrowLeft size={18} />
          </button>
          <div className="admin-brand">
            <h1>Ochi</h1>
            <span>{t("adminConsole")}</span>
          </div>
        </header>
        <nav aria-label={t("adminNavigation")}>
          {adminTabs().map((item) => (
            <button
              key={item.id}
              className={`${section === item.id || (item.id === "plugins" && (section === "skills" || section === "mcp")) ? "selected" : ""}${item.id === "users" ? " admin-nav-group-start" : ""}`}
              aria-current={section === item.id || (item.id === "plugins" && (section === "skills" || section === "mcp")) ? "page" : undefined}
              onClick={() => onNavigate(`/admin/${item.id}`)}
            >
              <item.icon size={18} />
              <span>{item.title}</span>
            </button>
          ))}
        </nav>
      </aside>
      <section className="admin-workspace">
        <div className="admin-content">
        <Suspense
          fallback={
            <div className="panel-loading">
              <LoaderCircle className="spin" size={22} />
            </div>
          }
        >
          {section === "search" ? (
            <SearchPage />
          ) : section === "plugins" || section === "skills" || section === "mcp" ? (
            <PluginsPage section={section} onNavigate={onNavigate} />
          ) : section === "users" ? (
            <UsersPage />
          ) : section === "settings" ? (
            <SystemPage />
          ) : section === "workspaces" ? (
            <WorkspacesPage />
          ) : section === "runs" ? (
            <RunsPage currentUserID={currentUserID} onNavigate={onNavigate} />
          ) : section === "debug" ? (
            <DebugPage />
          ) : (
            <ProvidersPage />
          )}
        </Suspense>
        </div>
      </section>
    </main>
  );
}
