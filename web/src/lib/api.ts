import { getLocale, t } from "./i18n";
import { translateError } from "../../../shared/i18n/errors";
import type { MessageParams } from "../../../shared/i18n";
import type {
  ApiError,
  AdminRunDetail,
  AdminRunFilter,
  AdminRunPage,
  AdminRunStats,
  ProviderRequestDetail,
  ProviderRequestPage,
  Artifact,
  MCPServer,
  Memory,
  Message,
  Model,
  Provider,
  Project,
  ProjectDetail,
  PendingRun,
  Plugin,
  PluginComponents,
  PluginConfig,
  ComputerState,
  CatalogModel,
  RunStatus,
  RunInstruction,
  Schedule,
  ScheduleExecution,
  Session,
  SessionHead,
  SessionPage,
  Skill,
  SkillDetail,
  Snapshot,
  User,
  UserPreferences,
  UpdateState,
  Workspace,
} from "./types";

export const API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, "") ??
  "";

export function userFacingRunError(_error = "", hasArtifacts = false, code?: string): string {
  if (hasArtifacts) return t("runError.artifacts");
  return translateError(code) ?? t("runError.failed");
}

function userFacingError(path: string, status: number): string {
  if (status === 401)
    return path.endsWith("/login") ? t("error.credentials") : t("error.signInAgain");
  if (status === 404) return t("error.notFound");
  if (status === 409) return t("error.conflict");
  if (status === 429) return t("error.rateLimited");
  if (status >= 500) return t("error.unavailable");
  if (status === 403) return t("error.forbidden");
  if (status === 413) return t("error.fileSize");
  return t("error.request");
}

export async function request<T>(
  path: string,
  init: RequestInit = {},
  options: { quiet?: boolean } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      credentials: "include",
      headers: {
        "Accept-Language": getLocale(),
        "X-Client-Timezone": Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        ...(init.body && !(init.body instanceof FormData)
          ? { "Content-Type": "application/json" }
          : {}),
        ...init.headers,
      },
    });
  } catch (reason) {
    if (init.signal?.aborted) throw reason;
    if (!options.quiet) console.error("API connection failed", path, reason);
    const error = new Error();
    Object.defineProperty(error, "message", { configurable: true, get: () => t("error.connect") });
    throw error;
  }
  if (!response.ok) {
    let detail = "";
    let code: string | undefined;
    let params: MessageParams | undefined;
    try {
      const body = (await response.json()) as { error?: string; code?: string; params?: MessageParams };
      detail = body.error ?? "";
      code = body.code;
      params = body.params;
    } catch {
      /* non-JSON error */
    }
    if (!options.quiet && !(path === "/api/auth/me" && response.status === 401))
      console.error("API request failed", path, response.status, detail);
    const error = new Error() as ApiError;
    Object.defineProperty(error, "message", {
      configurable: true,
      get: () => translateError(code, params) ?? userFacingError(path, response.status),
    });
    error.status = response.status;
    error.detail = detail;
    error.code = code;
    error.params = params;
    throw error;
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  me: () => request<User>("/api/auth/me"),
  login: (username: string, password: string) =>
    request<User>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  logout: () =>
    request<void>("/api/auth/logout", { method: "POST", body: "{}" }),
  models: () => request<Model[]>("/api/models"),
  sessionsPage: (
    options: { q?: string; cursor?: string; project_id?: string; limit?: number } = {},
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options))
      if (value !== undefined && value !== "") query.set(key, String(value));
    return request<SessionPage>(`/api/sessions/page?${query}`, { signal });
  },
  sessionHead: (id: string, signal?: AbortSignal) =>
    request<SessionHead>(`/api/sessions/${encodeURIComponent(id)}/head`, { signal }),
  session: (id: string) =>
    request<Session>(`/api/sessions/${encodeURIComponent(id)}`),
  createSession: (
    model_id?: string,
    effort?: string,
    project_id?: string,
    computer_enabled?: boolean,
  ) =>
    request<Session>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ model_id, effort, project_id, computer_enabled }),
    }),
  updateSession: (
    id: string,
    patch: {
      title?: string;
      model_id?: string;
      effort?: string;
      computer_enabled?: boolean;
      remember_computer_default?: boolean;
    },
  ) =>
    request<Session>(`/api/sessions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteSession: (id: string) =>
    request<void>(`/api/sessions/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  messages: (id: string, before?: string, signal?: AbortSignal) =>
    request<Message[]>(
      `/api/sessions/${encodeURIComponent(id)}/messages?limit=100${before ? `&before=${encodeURIComponent(before)}` : ""}`,
      { signal },
    ),
  startRun: (
    sessionId: string,
    message: string,
    options: {
      model_id?: string;
      effort?: string;
      attachment_ids?: string[];
      edit_message_id?: string;
      retry_run_id?: string;
      stop_current?: boolean;
      budget_tokens?: number;
      reasoning_enabled?: boolean;
    } = {},
  ) =>
    request<Snapshot>(`/api/sessions/${encodeURIComponent(sessionId)}/runs`, {
      method: "POST",
      body: JSON.stringify({ message, ...options }),
    }),
  run: (runId: string, signal?: AbortSignal) =>
    request<Snapshot>(`/api/runs/${encodeURIComponent(runId)}`, { signal }),
  runInstructions: (runId: string, signal?: AbortSignal) =>
    request<RunInstruction[]>(`/api/runs/${encodeURIComponent(runId)}/instructions`, { signal }),
  supplementRun: (runId: string, content: string, clientKey: string, signal?: AbortSignal) =>
    request<RunInstruction>(`/api/runs/${encodeURIComponent(runId)}/instructions`, {
      method: "POST", body: JSON.stringify({ content, client_key: clientKey }), signal,
    }),
  queue: (id: string, signal?: AbortSignal) =>
    request<PendingRun[]>(`/api/sessions/${encodeURIComponent(id)}/queue`, { signal }),
  updateQueuedRun: (id: string, runId: string, patch: { message: string }) =>
    request<PendingRun>(
      `/api/sessions/${encodeURIComponent(id)}/queue/${encodeURIComponent(runId)}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    ),
  cancelQueuedRun: (id: string, runId: string) =>
    request<void>(
      `/api/sessions/${encodeURIComponent(id)}/queue/${encodeURIComponent(runId)}`,
      { method: "DELETE" },
    ),
  projects: () => request<Project[]>("/api/projects"),
  project: (id: string) =>
    request<ProjectDetail>(`/api/projects/${encodeURIComponent(id)}`),
  saveProject: (value: Partial<Project>) =>
    request<Project>(
      value.id
        ? `/api/projects/${encodeURIComponent(value.id)}`
        : "/api/projects",
      {
        method: value.id ? "PATCH" : "POST",
        body: JSON.stringify({
          name: value.name,
          instructions: value.instructions,
        }),
      },
    ),
  deleteProject: (id: string) =>
    request<void>(`/api/projects/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  cancelRun: (runId: string) =>
    request<Snapshot>(`/api/runs/${encodeURIComponent(runId)}/cancel`, {
      method: "POST",
      body: "{}",
    }),
  resumeRun: (runId: string, answer: string) =>
    request<Snapshot>(`/api/runs/${encodeURIComponent(runId)}/resume`, {
      method: "POST",
      body: JSON.stringify({ answer }),
    }),
  upload: (file: File) => {
    const body = new FormData();
    body.append("file", file);
    return request<Artifact>("/api/files", { method: "POST", body });
  },
  files: (signal?: AbortSignal) => request<Artifact[]>("/api/files", { signal }),
  computerState: () => request<ComputerState>("/api/computer/state"),
  computerControl: (
    enabled: boolean,
    signal?: AbortSignal,
  ) =>
    request<ComputerState>("/api/computer/control", {
      method: "POST",
      body: JSON.stringify({ enabled }),
      signal,
    }),
  desktopUrl: (path: string) => {
    const url = new URL(`${API_BASE}${path}`, window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.href;
  },
  memories: (project_id?: string, q?: string) =>
    request<Memory[]>(
      `/api/memories?${new URLSearchParams({ ...(project_id ? { project_id } : {}), ...(q ? { q } : {}) })}`,
    ),
  addMemory: (content: string, metadata?: Partial<Memory>) =>
    request<Memory>("/api/memories", {
      method: "POST",
      body: JSON.stringify({
        content,
        ...(metadata?.kind ? { kind: metadata.kind } : {}),
        ...(metadata && "project_id" in metadata
          ? { project_id: metadata.project_id ?? "" }
          : {}),
      }),
    }),
  updateMemory: (id: string, content: string, metadata?: Partial<Memory>) =>
    request<Memory>(`/api/memories/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        content,
        ...(metadata?.kind ? { kind: metadata.kind } : {}),
        ...(metadata && "project_id" in metadata
          ? { project_id: metadata.project_id ?? "" }
          : {}),
      }),
    }),
  deleteMemory: (id: string) =>
    request<void>(`/api/memories/${id}`, { method: "DELETE" }),
  preferences: () => request<UserPreferences>("/api/preferences"),
  plugins: (signal?: AbortSignal) => request<Plugin[]>("/api/plugins", { signal }),
  updatePlugin: (id: string, enabled: boolean) =>
    request<Plugin>(`/api/plugins/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    }),
  updatePreferences: (patch: Partial<UserPreferences>) =>
    request<UserPreferences>("/api/preferences", {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  schedules: () => request<Schedule[]>("/api/schedules"),
  schedule: (id: string) =>
    request<Schedule>(`/api/schedules/${encodeURIComponent(id)}`),
  scheduleExecutions: (id: string) =>
    request<ScheduleExecution[]>(
      `/api/schedules/${encodeURIComponent(id)}/executions`,
    ),
  scheduleExecution: (id: string, executionId: string) =>
    request<ScheduleExecution>(
      `/api/schedules/${encodeURIComponent(id)}/executions/${encodeURIComponent(executionId)}`,
    ),
  runSchedule: (id: string) =>
    request<Snapshot>(`/api/schedules/${encodeURIComponent(id)}/run`, {
      method: "POST",
      body: "{}",
    }),
  saveSchedule: (value: Partial<Schedule>) =>
    request<Schedule>(
      value.id ? `/api/schedules/${value.id}` : "/api/schedules",
      {
        method: value.id ? "PATCH" : "POST",
        body: JSON.stringify(value),
      },
    ),
  deleteSchedule: (id: string) =>
    request<void>(`/api/schedules/${id}`, { method: "DELETE" }),
  eventsUrl: (runId: string) =>
    `${API_BASE}/api/runs/${encodeURIComponent(runId)}/events`,
};

function providerRequestsPath(runID?: string) {
  return runID
    ? `/api/admin/runs/${encodeURIComponent(runID)}/requests`
    : "/api/admin/requests";
}

export const adminApi = {
  providers: () => request<Provider[]>("/api/admin/providers"),
  models: () => request<Model[]>("/api/admin/models"),
  saveModelOrder: (model_ids: string[], default_model_id: string) =>
    request<void>("/api/admin/models/order", {
      method: "PUT",
      body: JSON.stringify({ model_ids, default_model_id }),
    }),
  resolveMetadata: (providerId: string, model: string) =>
    request<{ matched: boolean; model?: Model; metadata_match: string }>(
      `/api/admin/catalog/resolve?provider_id=${encodeURIComponent(providerId)}&model=${encodeURIComponent(model)}`,
    ),
  refreshMetadata: (providerId: string) =>
    request<{ models: Model[]; matched: number; unmatched: number }>(
      `/api/admin/providers/${encodeURIComponent(providerId)}/metadata`,
      { method: "POST", body: "{}" },
    ),
  autoMatchModel: (id: string) =>
    request<Model>(`/api/admin/models/${encodeURIComponent(id)}/catalog`, {
      method: "POST",
      body: JSON.stringify({ auto: true, apply: true, reset_overrides: true }),
    }),
  users: () => request<User[]>("/api/admin/users"),
  skills: () => request<Skill[]>("/api/admin/skills"),
  skill: (id: string) =>
    request<SkillDetail>(`/api/admin/skills/${encodeURIComponent(id)}`),
  mcp: () => request<MCPServer[]>("/api/admin/mcp"),
  plugins: (signal?: AbortSignal) =>
    request<Plugin[]>("/api/admin/plugins", { signal }),
  pluginComponents: (signal?: AbortSignal) =>
    request<PluginComponents>("/api/admin/plugins/components", { signal }),
  savePlugin: (value: PluginConfig, existing = false) => {
    const { id, ...config } = value;
    return request<Plugin>(`/api/admin/plugins${existing ? `/${encodeURIComponent(id)}` : ""}`, {
      method: existing ? "PATCH" : "POST",
      body: JSON.stringify(existing ? config : value),
    });
  },
  updatePlugin: (id: string, patch: Partial<Omit<PluginConfig, "id">>) =>
    request<Plugin>(`/api/admin/plugins/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deletePlugin: (id: string) =>
    request<void>(`/api/admin/plugins/${encodeURIComponent(id)}`, { method: "DELETE" }),
  workspaces: () => request<Workspace[]>("/api/admin/workspaces"),
  runs: (filters: AdminRunFilter = {}, signal?: AbortSignal) =>
    request<AdminRunPage>(`/api/admin/runs?${new URLSearchParams(
      Object.entries(filters).map(([key, value]) => [key, String(value)]),
    )}`, { signal }),
  runStats: (filters: AdminRunFilter = {}, signal?: AbortSignal) =>
    request<AdminRunStats>(`/api/admin/runs/stats?${new URLSearchParams(
      Object.entries(filters).map(([key, value]) => [key, String(value)]),
    )}`, { signal }),
  run: (id: string, signal?: AbortSignal) =>
    request<AdminRunDetail>(`/api/admin/runs/${encodeURIComponent(id)}`, { signal }),
  providerRequests: (runID: string | undefined, offset = 0, signal?: AbortSignal) =>
    request<ProviderRequestPage>(`${providerRequestsPath(runID)}?limit=30&offset=${offset}`, { signal }),
  providerRequest: (runID: string | undefined, id: string, signal?: AbortSignal) =>
    request<ProviderRequestDetail>(`${providerRequestsPath(runID)}/${encodeURIComponent(id)}`, { signal }),
  clearProviderRequests: (runID?: string, signal?: AbortSignal) =>
    request<void>(providerRequestsPath(runID), { method: "DELETE", signal }),
  settings: () => request<Record<string, unknown>>("/api/admin/settings"),
  updates: (signal?: AbortSignal) =>
    request<UpdateState>("/api/admin/updates", { signal }, { quiet: true }),
  checkUpdate: (signal?: AbortSignal) =>
    request<UpdateState>("/api/admin/updates/check", {
      method: "POST", body: "{}", signal,
    }, { quiet: true }),
  applyUpdate: (revision: string, signal?: AbortSignal) =>
    request<UpdateState>("/api/admin/updates/apply", {
      method: "POST", body: JSON.stringify({ revision }), signal,
    }, { quiet: true }),
  restartUpdate: (signal?: AbortSignal) =>
    request<UpdateState>("/api/admin/updates/restart", {
      method: "POST", body: "{}", signal,
    }, { quiet: true }),
  rollbackUpdate: (signal?: AbortSignal) =>
    request<UpdateState>("/api/admin/updates/rollback", {
      method: "POST", body: "{}", signal,
    }, { quiet: true }),
  catalogProviders: () =>
    request<{ id: string; name: string; model_count?: number }[]>(
      "/api/admin/catalog/providers",
    ),
  catalogModels: (provider: string, q = "") =>
    request<CatalogModel[]>(
      `/api/admin/catalog/models?provider=${encodeURIComponent(provider)}&q=${encodeURIComponent(q)}`,
    ),
  syncProvider: (id: string) =>
    request<{
      provider: Provider;
      models: Model[];
      imported: number;
      unavailable: number;
    }>(`/api/admin/providers/${encodeURIComponent(id)}/sync`, {
      method: "POST",
      body: "{}",
    }),
  applyCatalog: (
    id: string,
    catalog_provider_id: string,
    catalog_model_id: string,
  ) =>
    request<Model>(`/api/admin/models/${encodeURIComponent(id)}/catalog`, {
      method: "POST",
      body: JSON.stringify({
        catalog_provider_id,
        catalog_model_id,
        apply: true,
      }),
    }),
  saveSettings: (value: unknown) =>
    request<Record<string, unknown>>("/api/admin/settings", {
      method: "PATCH",
      body: JSON.stringify(value),
    }),
  save: <T>(kind: string, value: Record<string, unknown>, existing?: boolean) =>
    request<T>(
      `/api/admin/${kind}${existing ? `/${encodeURIComponent(String(value.id))}` : ""}`,
      {
        method: existing ? "PATCH" : "POST",
        body: JSON.stringify(value),
      },
    ),
  remove: (kind: string, id: string) =>
    request<void>(`/api/admin/${kind}/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  test: (kind: string, id: string, options: Record<string, unknown> = {}) =>
    request<{
      ok: boolean;
      tools?: unknown[];
      models?: string[];
      error?: string;
      detail?: string;
      error_code?: string;
      error_params?: MessageParams;
      status?: number;
      parameter_accepted?: boolean;
    }>(`/api/admin/${kind}/${encodeURIComponent(id)}/test`, {
      method: "POST",
      body: JSON.stringify(options),
    }),
  installSkill: async (id: string, command: string, userId = "") => {
    const result = await request<{
      exit_code?: number;
      stdout?: string;
      stderr?: string;
      timed_out?: boolean;
      isError?: boolean;
    }>(`/api/admin/skills/${encodeURIComponent(id)}/install`, {
      method: "POST",
      body: JSON.stringify({ command, user_id: userId, timeout_ms: 120000 }),
    });
    if (
      result.timed_out ||
      result.isError ||
      (typeof result.exit_code === "number" && result.exit_code !== 0)
    )
      throw new Error(
        result.timed_out
          ? t("error.installTimeout")
          : result.stderr?.trim().slice(-1000) ||
              `${t("error.install")}${result.exit_code === undefined ? "" : ` (${result.exit_code})`}`,
      );
    return result;
  },
  workspace: (userId: string, action: string) =>
    request<unknown>(
      `/api/admin/workspaces/${encodeURIComponent(userId)}/${action}`,
      {
        method: "POST",
        body: "{}",
      },
    ),
};

export function isActiveStatus(status: RunStatus | undefined): boolean {
  return (
    status === "running" ||
    status === "cancelling" ||
    status === "waiting_user" ||
    status === "waiting_resource" ||
    status === "queued"
  );
}
