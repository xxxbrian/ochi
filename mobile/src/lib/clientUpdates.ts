import type { AndroidClientRelease, ClientReleases } from "./types";

export type InstalledClientVersion = { packageName: string; versionName: string; versionCode: number };
export type ClientUpdateErrorCode = "check" | "download" | "integrity" | "package" | "permission" | "install" | "open";
export class ClientUpdateError extends Error {
  constructor(readonly code: ClientUpdateErrorCode) { super(code); }
}
export class ClientReleaseUnavailableError extends ClientUpdateError {
  constructor() { super("download"); }
}
export type ClientUpdateState = {
  server: string;
  installed: InstalledClientVersion | null;
  releases: ClientReleases | null;
  checking: boolean;
  checked: boolean;
  phase: "idle" | "downloading" | "verifying" | "ready" | "permission";
  received: number;
  total: number;
  localPath: string | null;
  error: ClientUpdateErrorCode | null;
  showNotice: boolean;
};
export type ClientUpdateDriver = {
  platform: string;
  now: () => number;
  installed: () => Promise<InstalledClientVersion>;
  releases: (server: string, signal: AbortSignal) => Promise<ClientReleases>;
  download: (
    server: string, release: AndroidClientRelease, signal: AbortSignal,
    progress: (received: number) => void, verifying: () => void,
  ) => Promise<string>;
  verify: (path: string, release: AndroidClientRelease, signal: AbortSignal) => Promise<void>;
  remove: (path: string) => Promise<void>;
  clearCache: () => Promise<void>;
  canInstall: () => Promise<boolean>;
  openPermissionSettings: () => Promise<void>;
  openInstaller: (path: string) => Promise<void>;
  openIOS: (url: string) => Promise<void>;
};

const automaticInterval = 6 * 60 * 60 * 1000;
const failureInterval = 15 * 60 * 1000;
const initial = (server = ""): ClientUpdateState => ({
  server, installed: null, releases: null, checking: false, checked: false,
  phase: "idle", received: 0, total: 0, localPath: null, error: null, showNotice: false,
});
export function availableAndroidRelease(state: ClientUpdateState) {
  const release = state.releases?.android;
  return release && state.installed && release.version_code > state.installed.versionCode ? release : null;
}

export function createClientUpdateController(driver: ClientUpdateDriver) {
  let state = initial();
  const listeners = new Set<() => void>();
  const checks = new Map<string, number>();
  const dismissed = new Set<string>();
  let generation = 0;
  let checkAbort: AbortController | undefined;
  let downloadAbort: AbortController | undefined;
  let actionAbort: AbortController | undefined;
  let checking: Promise<void> | undefined;
  let downloading: Promise<void> | undefined;
  let installing = false;
  let cleanup: Promise<void> | undefined;
  const emit = (patch: Partial<ClientUpdateState>) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };
  const releaseKey = () => `${state.server}\0${state.releases?.android?.sha256 ?? ""}`;
  const notice = () => Boolean(availableAndroidRelease(state)) && !dismissed.has(releaseKey());
  const current = (owner: number, signal?: AbortSignal) => owner === generation && !signal?.aborted;
  const remove = (path: string | null) => path ? driver.remove(path).catch(() => undefined) : Promise.resolve();
  const errorCode = (reason: unknown, fallback: ClientUpdateErrorCode) =>
    reason instanceof ClientUpdateError ? reason.code : fallback;
  const prepareCache = () => cleanup ??= driver.clearCache().catch((reason) => {
    cleanup = undefined;
    throw reason;
  });

  async function configure(server: string) {
    if (server === state.server) return;
    generation++;
    checkAbort?.abort(); downloadAbort?.abort(); actionAbort?.abort();
    checking = undefined; downloading = undefined; installing = false;
    const oldPath = state.localPath;
    state = initial(server);
    listeners.forEach((listener) => listener());
    if (driver.platform === "android") await prepareCache().catch(() => undefined);
    await remove(oldPath);
  }

  async function refresh(manual = false, signal?: AbortSignal, retainedError: ClientUpdateErrorCode | null = null) {
    if (!state.server || (driver.platform !== "android" && !manual)) return;
    if (checking) return checking;
    if (!manual && driver.now() < (checks.get(state.server) ?? 0)) return;
    if (state.phase === "downloading" || state.phase === "verifying" || installing) return;
    const owner = generation;
    const server = state.server;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort);
    if (signal?.aborted) controller.abort();
    checkAbort = controller;
    checks.set(server, driver.now() + failureInterval);
    emit({ checking: true, error: null });
    const operation = (async () => {
      try {
        const [releases, installed] = await Promise.all([
          driver.releases(server, controller.signal),
          driver.platform === "android" ? driver.installed() : Promise.resolve(null),
        ]);
        if (!current(owner, controller.signal)) return;
        const changed = releases.android?.sha256 !== state.releases?.android?.sha256;
        const noUpdate = !releases.android || (installed && releases.android.version_code <= installed.versionCode);
        const oldPath = changed || noUpdate ? state.localPath : null;
        emit({
          releases, installed, checked: true, error: retainedError,
          ...(changed || noUpdate ? { localPath: null, phase: "idle" as const, received: 0, total: 0 } : {}),
        });
        emit({ showNotice: driver.platform === "android" && notice() });
        checks.set(server, driver.now() + automaticInterval);
        await remove(oldPath);
      } catch (reason) {
        if (current(owner, controller.signal)) emit({ error: errorCode(reason, "check") });
      } finally {
        signal?.removeEventListener("abort", abort);
        if (owner === generation && checkAbort === controller) emit({ checking: false });
        if (checkAbort === controller) { checkAbort = undefined; checking = undefined; }
      }
    })();
    checking = operation;
    return operation;
  }

  const check = (manual = false) => refresh(manual);

  async function download() {
    const release = availableAndroidRelease(state);
    if (!release || checking || downloading || installing) return;
    const owner = generation;
    const server = state.server;
    const controller = new AbortController();
    downloadAbort = controller;
    const oldPath = state.localPath;
    emit({ localPath: null, error: null, phase: "downloading", received: 0, total: release.size_bytes });
    const operation = (async () => {
      try {
        // Purge interrupted downloads once per process before creating a new private file.
        await prepareCache();
        await remove(oldPath);
        if (!current(owner, controller.signal)) return;
        const path = await driver.download(server, release, controller.signal,
          (received) => { if (current(owner, controller.signal)) emit({ received }); },
          () => { if (current(owner, controller.signal)) emit({ phase: "verifying" }); });
        if (!current(owner, controller.signal)) { await remove(path); return; }
        emit({ localPath: path, phase: "ready", received: release.size_bytes });
      } catch (reason) {
        if (!current(owner, controller.signal)) return;
        emit({ phase: "idle", error: errorCode(reason, "download") });
        if (reason instanceof ClientReleaseUnavailableError) {
          // A replaced/unpublished hash is no longer retryable. Refresh once, without downloading again.
          emit({
            releases: state.releases ? { ...state.releases, android: null } : null,
            checked: false, showNotice: false,
          });
          await refresh(true, controller.signal, "download");
        }
      } finally {
        if (downloadAbort === controller) { downloadAbort = undefined; downloading = undefined; }
      }
    })();
    downloading = operation;
    return operation;
  }

  function cancel() {
    downloadAbort?.abort();
    actionAbort?.abort();
    if (state.phase === "downloading" || state.phase === "verifying")
      emit({ phase: state.localPath ? "ready" : "idle", error: null, received: 0, total: 0 });
  }

  async function clearDownload() {
    if (downloading || installing) return;
    const path = state.localPath;
    emit({ localPath: null, phase: "idle", received: 0, total: 0, error: null });
    await remove(path);
  }

  async function install() {
    const release = availableAndroidRelease(state);
    const path = state.localPath;
    if (!release || !path || checking || installing || downloading) return;
    const owner = generation;
    const controller = new AbortController();
    actionAbort = controller;
    installing = true;
    emit({ phase: "verifying", error: null });
    try {
      await driver.verify(path, release, controller.signal);
      if (!current(owner, controller.signal)) return;
      const allowed = await driver.canInstall();
      if (!current(owner, controller.signal)) return;
      if (!allowed) { emit({ phase: "permission" }); return; }
      // Launching the installer is not an installation receipt. Keep the verified file retryable.
      await driver.openInstaller(path);
      if (current(owner, controller.signal)) emit({ phase: "ready" });
    } catch (reason) {
      if (!current(owner, controller.signal)) return;
      const code = errorCode(reason, "install");
      if (code === "integrity" || code === "package") {
        emit({ phase: "idle", localPath: null, error: code });
        await remove(path);
      } else emit({ phase: "ready", error: code });
    } finally {
      if (actionAbort === controller) { actionAbort = undefined; installing = false; }
    }
  }

  async function openPermissionSettings() {
    if (checking || state.phase !== "permission" || !state.localPath) return;
    const owner = generation;
    try { await driver.openPermissionSettings(); }
    catch { if (current(owner)) emit({ error: "permission" }); }
  }

  async function foreground() {
    if (driver.platform !== "android") return;
    const owner = generation;
    if (state.localPath) {
      try {
        const installed = await driver.installed();
        if (!current(owner)) return;
        emit({ installed });
        if (!availableAndroidRelease(state)) {
          await clearDownload();
          if (current(owner)) emit({ showNotice: false });
        } else if (state.phase === "permission" && await driver.canInstall() && current(owner))
          emit({ phase: "ready", error: null });
      } catch { /* The explicit check/install action can report native errors. */ }
    }
    if (current(owner)) await check();
  }

  async function openIOS() {
    const url = state.releases?.ios?.url;
    if (!url) return;
    const owner = generation;
    try { await driver.openIOS(url); }
    catch { if (current(owner)) emit({ error: "open" }); }
  }

  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    configure, check, download, cancel, install, clearDownload, openPermissionSettings, foreground, openIOS,
    dismissNotice() { dismissed.add(releaseKey()); emit({ showNotice: false }); },
    dispose() {
      generation++; checkAbort?.abort(); downloadAbort?.abort(); actionAbort?.abort();
      checking = undefined; downloading = undefined; installing = false;
      state = { ...state, checking: false, phase: state.localPath ? "ready" : "idle" };
      listeners.clear();
    },
  };
}

export type ClientUpdateController = ReturnType<typeof createClientUpdateController>;
