import { useCallback, useEffect, useState } from "react";
export type Route = {
  kind: "chat" | "projects" | "tasks" | "admin";
  id?: string;
  runId?: string;
  section?: string;
};
export function routeFor(path: string): Route {
  const parts = path
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));
  if (parts[0] === "admin")
    return { kind: "admin", section: parts[1] || "providers" };
  if (parts[0] === "projects") return { kind: "projects", id: parts[1] };
  if (parts[0] === "tasks")
    return {
      kind: "tasks",
      id: parts[1],
      runId: parts[2] === "runs" ? parts[3] : undefined,
    };
  return { kind: "chat", id: parts[0] === "c" ? parts[1] : undefined };
}
export function useRouter() {
  const [path, setPath] = useState(window.location.pathname);
  const navigate = useCallback((next: string, replace = false) => {
    if (window.location.pathname !== next)
      window.history[replace ? "replaceState" : "pushState"](null, "", next);
    setPath(next);
  }, []);
  useEffect(() => {
    const pop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  return { route: routeFor(path), path, navigate };
}
export function statusLabel(status?: string) {
  return (
    (
      {
        queued: "排队中",
        running: "运行中",
        waiting_user: "等待回复",
        waiting_resource: "等待工作区",
        cancelling: "正在停止",
        completed: "已完成",
        failed: "未完成",
        cancelled: "已停止",
        interrupted: "已中断",
        skipped: "已跳过",
      } as Record<string, string>
    )[status ?? ""] ??
    status ??
    ""
  );
}
