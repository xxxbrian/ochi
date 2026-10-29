import { t } from "./i18n";
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
        queued: t("status.queued"),
        running: t("status.running"),
        waiting_user: t("status.awaitingReply"),
        waiting_resource: t("status.awaitingWorkspace"),
        cancelling: t("status.stopping"),
        completed: t("status.completed"),
        failed: t("status.failed"),
        cancelled: t("status.stopped"),
        interrupted: t("status.interrupted"),
        skipped: t("status.skipped"),
      } as Record<string, string>
    )[status ?? ""] ??
    status ??
    ""
  );
}
