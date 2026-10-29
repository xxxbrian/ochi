import { localizedError } from "./errors";
import { t, getLocale } from "./i18n";
import { translateError } from '../../../shared/i18n/errors';
import { fetch } from 'expo/fetch';
import { File } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import type { ImageURISource } from 'react-native';
import type {
  ApiError, Artifact, Memory, Message, Model, NativeUpload,
  PendingRun, Project, ProjectDetail, RunOptions, RunStatus, Schedule, ScheduleExecution,
  Plugin, Session, SessionHead, SessionPage, SessionPatch, Snapshot, User, UserPreferences,
  RunInstruction,
} from './types';

const AUTH_KEY = 'ochi.auth.v1';
const SERVER_KEY = 'ochi.server.v1';
const storageOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
export const DEFAULT_API_BASE_URL = 'https://ochi.bojin.co';
let serverURL = initialServerURL(process.env.EXPO_PUBLIC_API_URL?.trim() || DEFAULT_API_BASE_URL);
let accessToken: string | null = null;
let onUnauthorized: (() => void) | undefined;

export function getAPIBaseURL() { return serverURL; }

function normalizeAPIBaseURL(value: string) {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw localizedError("error.serverAddress"); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw localizedError("error.serverProtocol");
  if (url.username || url.password || url.search || url.hash || !['/', '/api', '/api/'].includes(url.pathname)) throw localizedError("error.serverRoot");
  return url.origin;
}

function initialServerURL(value: string) {
  try { return normalizeAPIBaseURL(value); } catch { return ''; }
}

export function isConfiguredAPIBaseURL(value = serverURL) {
  try { normalizeAPIBaseURL(value); return true; } catch { return false; }
}

function requireAPIBaseURL() {
  if (!isConfiguredAPIBaseURL()) throw localizedError("error.configureServer");
  return serverURL;
}

export async function setAPIBaseURL(value: string) {
  const nextURL = normalizeAPIBaseURL(value);
  if (nextURL !== serverURL) await clearCredentials();
  serverURL = nextURL;
  await SecureStore.setItemAsync(SERVER_KEY, serverURL, storageOptions);
}

export async function restoreCredentials() {
  const [savedURL, savedToken] = await Promise.all([
    SecureStore.getItemAsync(SERVER_KEY), SecureStore.getItemAsync(AUTH_KEY),
  ]);
  // Never pair a saved credential with a new build default or an unsafe address.
  if (savedURL) serverURL = initialServerURL(savedURL);
  accessToken = savedURL && serverURL ? savedToken : null;
  return Boolean(accessToken);
}

export async function clearCredentials() {
  accessToken = null;
  await SecureStore.deleteItemAsync(AUTH_KEY);
}

export function setUnauthorizedHandler(handler?: () => void) { onUnauthorized = handler; }
export function authHeaders(): Record<string, string> { return accessToken ? { Authorization: `Bearer ${accessToken}` } : {}; }

export function fileURL(value: string | Artifact) {
  const path = typeof value === 'string' ? value : value.url;
  return new URL(path, `${requireAPIBaseURL()}/`).href;
}

export function resourceHeaders(value: string | Artifact) {
  if (!serverURL) return {};
  return new URL(fileURL(value)).origin === new URL(serverURL).origin ? { ...authHeaders(), 'Accept-Language': getLocale() } : {};
}

export function imageSource(value: string | Artifact): ImageURISource[] {
  // RN 0.86 Android forwards HTTP headers only for the source-array branch.
  return [{ uri: fileURL(value), headers: resourceHeaders(value) }];
}

// Only the trusted computer viewer needs a cookie-enabled same-origin WebView.
export function webViewSource(path: string) {
  return { uri: `${requireAPIBaseURL()}/api/auth/webview?next=${encodeURIComponent(path)}`, headers: { ...authHeaders(), 'Accept-Language': getLocale() } };
}

function errorMessage(path: string, status: number, code?: string, params?: Record<string, string | number>) {
  const translated = translateError(code, params);
  if (translated) return translated;
  if (status === 401) return path.endsWith('/login') ? t("error.credentials") : t("error.signInAgain");
  if (status === 404) return t("error.notFound");
  if (status === 403) return t("error.forbidden");
  if (status === 409) return t("error.conflict");
  if (status === 413) return t("error.fileTooLarge");
  if (status === 429) return t("error.tryLater");
  if (status >= 500) return t("error.serviceUnavailable");
  return t("error.request");
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const base = requireAPIBaseURL();
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        'X-Client-Timezone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        'Accept-Language': getLocale(),
        ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        ...authHeaders(), ...init.headers,
      },
    });
  } catch (reason) {
    if (init.signal?.aborted) throw reason;
    throw localizedError("error.connection");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string; code?: string; params?: Record<string, string | number> };
    const error = new Error(errorMessage(path, response.status, body.code, body.params)) as ApiError;
    error.status = response.status;
    error.detail = body.error ?? '';
    error.code = body.code;
    error.params = body.params;
    if (response.status === 401 && !path.endsWith('/login')) onUnauthorized?.();
    throw error;
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

const json = (method: string, value: unknown = {}) => ({ method, body: JSON.stringify(value) });
const id = encodeURIComponent;

export const api = {
  me: () => request<User>('/api/auth/me'),
  login: async (username: string, password: string) => {
    const response = await request<User & { access_token: string; expires_at: string }>('/api/auth/login', json('POST', { username, password, native: true }));
    if (!response.access_token) throw localizedError("error.nativeLogin");
    accessToken = response.access_token;
    await SecureStore.setItemAsync(AUTH_KEY, accessToken, storageOptions);
    const { access_token: _token, expires_at: _expires, ...user } = response;
    return user as User;
  },
  logout: () => request<void>('/api/auth/logout', json('POST')),
  models: () => request<Model[]>('/api/models'),
  sessionsPage: (options: { q?: string; cursor?: string; project_id?: string; limit?: number } = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    Object.entries(options).forEach(([key, value]) => { if (value !== undefined && value !== '') params.set(key, String(value)); });
    return request<SessionPage>(`/api/sessions/page?${params}`, { signal });
  },
  sessionHead: (sessionId: string, signal?: AbortSignal) => request<SessionHead>(`/api/sessions/${id(sessionId)}/head`, { signal }),
  session: (sessionId: string) => request<Session>(`/api/sessions/${id(sessionId)}`),
  createSession: (model_id?: string, effort?: string, project_id?: string, computer_enabled?: boolean) => request<Session>('/api/sessions', json('POST', { model_id, effort, project_id, computer_enabled })),
  updateSession: (sessionId: string, patch: SessionPatch) => request<Session>(`/api/sessions/${id(sessionId)}`, json('PATCH', patch)),
  deleteSession: (sessionId: string) => request<void>(`/api/sessions/${id(sessionId)}`, { method: 'DELETE' }),
  messages: (sessionId: string, before?: string, signal?: AbortSignal) => request<Message[]>(`/api/sessions/${id(sessionId)}/messages?limit=100${before ? `&before=${id(before)}` : ''}`, { signal }),
  startRun: (sessionId: string, message: string, options: RunOptions = {}) => request<Snapshot>(`/api/sessions/${id(sessionId)}/runs`, json('POST', { message, ...options })),
  run: (runId: string, signal?: AbortSignal) => request<Snapshot>(`/api/runs/${id(runId)}`, { signal }),
  runInstructions: (runId: string, signal?: AbortSignal) => request<RunInstruction[]>(`/api/runs/${id(runId)}/instructions`, { signal }),
  supplementRun: (runId: string, content: string, clientKey: string, signal?: AbortSignal) => request<RunInstruction>(`/api/runs/${id(runId)}/instructions`, { ...json('POST', { content, client_key: clientKey }), signal }),
  queue: (sessionId: string, signal?: AbortSignal) => request<PendingRun[]>(`/api/sessions/${id(sessionId)}/queue`, { signal }),
  updateQueuedRun: (sessionId: string, runId: string, patch: { message: string }) => request<PendingRun>(`/api/sessions/${id(sessionId)}/queue/${id(runId)}`, json('PATCH', patch)),
  cancelQueuedRun: (sessionId: string, runId: string) => request<void>(`/api/sessions/${id(sessionId)}/queue/${id(runId)}`, { method: 'DELETE' }),
  cancelRun: (runId: string) => request<Snapshot>(`/api/runs/${id(runId)}/cancel`, json('POST')),
  resumeRun: (runId: string, answer: string) => request<Snapshot>(`/api/runs/${id(runId)}/resume`, json('POST', { answer })),
  projects: () => request<Project[]>('/api/projects'),
  project: (projectId: string) => request<ProjectDetail>(`/api/projects/${id(projectId)}`),
  saveProject: (value: Partial<Project>) => request<Project>(value.id ? `/api/projects/${id(value.id)}` : '/api/projects', json(value.id ? 'PATCH' : 'POST', { name: value.name, instructions: value.instructions })),
  deleteProject: (projectId: string) => request<void>(`/api/projects/${id(projectId)}`, { method: 'DELETE' }),
  upload: async (file: NativeUpload) => {
    const source = new File(file.uri);
    if (source.size > 32 * 1024 * 1024) throw localizedError("error.fileTooLarge");
    const boundary = `ochi-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const name = file.name.replace(/["\r\n\\]/g, '_');
    const mime = (file.mimeType || source.type || 'application/octet-stream').replace(/[\r\n]/g, '');
    const encoder = new TextEncoder();
    // Expo's FormData encoder percent-escapes Unicode filenames; Go expects UTF-8.
    const prefix = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`);
    const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
    const bytes = await source.bytes();
    const body = new Uint8Array(prefix.length + bytes.length + suffix.length);
    body.set(prefix); body.set(bytes, prefix.length); body.set(suffix, prefix.length + bytes.length);
    return request<Artifact>('/api/files', { method: 'POST', body, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } });
  },
  memories: (project_id?: string, q?: string) => request<Memory[]>(`/api/memories?${new URLSearchParams({ ...(project_id ? { project_id } : {}), ...(q ? { q } : {}) })}`),
  addMemory: (content: string, metadata?: Partial<Memory>) => request<Memory>('/api/memories', json('POST', { content, kind: metadata?.kind, project_id: metadata?.project_id })),
  updateMemory: (memoryId: string, content: string, metadata?: Partial<Memory>) => request<Memory>(`/api/memories/${id(memoryId)}`, json('PATCH', { content, kind: metadata?.kind, project_id: metadata?.project_id })),
  deleteMemory: (memoryId: string) => request<void>(`/api/memories/${id(memoryId)}`, { method: 'DELETE' }),
  preferences: () => request<UserPreferences>('/api/preferences'),
  updatePreferences: (patch: Partial<UserPreferences>) => request<UserPreferences>('/api/preferences', json('PATCH', patch)),
  plugins: (signal?: AbortSignal) => request<Plugin[]>('/api/plugins', { signal }),
  updatePlugin: (pluginId: string, enabled: boolean, signal?: AbortSignal) => request<Plugin>(`/api/plugins/${id(pluginId)}`, { ...json('PATCH', { enabled }), signal }),
  schedules: () => request<Schedule[]>('/api/schedules'),
  schedule: (scheduleId: string) => request<Schedule>(`/api/schedules/${id(scheduleId)}`),
  scheduleExecutions: (scheduleId: string) => request<ScheduleExecution[]>(`/api/schedules/${id(scheduleId)}/executions`),
  scheduleExecution: (scheduleId: string, executionId: string) => request<ScheduleExecution>(`/api/schedules/${id(scheduleId)}/executions/${id(executionId)}`),
  runSchedule: (scheduleId: string) => request<Snapshot>(`/api/schedules/${id(scheduleId)}/run`, json('POST')),
  saveSchedule: (value: Partial<Schedule>) => request<Schedule>(value.id ? `/api/schedules/${id(value.id)}` : '/api/schedules', json(value.id ? 'PATCH' : 'POST', value)),
  deleteSchedule: (scheduleId: string) => request<void>(`/api/schedules/${id(scheduleId)}`, { method: 'DELETE' }),
  eventsUrl: (runId: string) => `${requireAPIBaseURL()}/api/runs/${id(runId)}/events`,
};

export function isActiveStatus(status?: RunStatus): boolean {
  return status === 'running' || status === 'cancelling' || status === 'waiting_user' || status === 'waiting_resource' || status === 'queued';
}

export function userFacingRunError(_error = '', hasArtifacts = false, code?: string) {
  if (hasArtifacts) return t("error.runWithFiles");
  return translateError(code) ?? t("error.run");
}
