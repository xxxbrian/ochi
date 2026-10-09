import { lazy, Suspense } from "react";
import {
  Activity,
  ArrowLeft,
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
const ProvidersPage = lazy(() => import("../pages/admin/ProvidersPage"));
const SearchPage = lazy(() => import("../pages/admin/SearchPage"));
const PluginsPage = lazy(() => import("../pages/admin/PluginsPage"));
const tabs = [
  { id: "providers", title: "模型服务", icon: Plug },
  { id: "search", title: "网页搜索", icon: Search },
  { id: "plugins", title: "插件", icon: Puzzle },
  { id: "users", title: "用户", icon: Users },
  { id: "workspaces", title: "工作区", icon: Cpu },
  { id: "runs", title: "运行记录", icon: Activity },
  { id: "settings", title: "系统", icon: Settings2 },
];
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
  return (
    <main className="admin-app">
      <aside className="admin-sidebar">
        <header>
          <button
            className="icon-button"
            onClick={onBack}
            aria-label="返回聊天"
          >
            <ArrowLeft size={18} />
          </button>
          <div className="admin-brand">
            <h1>Ochi</h1>
            <span>管理后台</span>
          </div>
        </header>
        <nav aria-label="后台导航">
          {tabs.map((item) => (
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
          ) : (
            <ProvidersPage />
          )}
        </Suspense>
        </div>
      </section>
    </main>
  );
}
