import { fetch } from "expo/fetch";
import * as FileSystem from "expo-file-system/legacy";
import { Linking, NativeModules, Platform } from "react-native";
import BlobUtil from "react-native-blob-util";
import type { AndroidClientRelease, ClientReleases } from "./types";
import { ClientReleaseUnavailableError, ClientUpdateError, type ClientUpdateDriver, type InstalledClientVersion } from "./clientUpdates";

type InstallerModule = {
  getInstalledVersion: () => Promise<InstalledClientVersion>;
  canRequestPackageInstalls: () => Promise<boolean>;
  openInstallPermissionSettings: () => Promise<void>;
  inspectApk: (path: string) => Promise<InstalledClientVersion>;
};
function installer(): InstallerModule {
  const module = NativeModules.OchiClientInstaller as InstallerModule | undefined;
  if (!module) throw new ClientUpdateError("install");
  return module;
}

export function iosDistributionURL(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) throw new ClientUpdateError("check");
  let url: URL;
  try { url = new URL(value); } catch { throw new ClientUpdateError("check"); }
  if (url.protocol !== "https:" || url.username || url.password) throw new ClientUpdateError("check");
  return url.href;
}

export function androidDownloadURL(server: string, release: AndroidClientRelease) {
  let url: URL;
  try { url = new URL(release.download_url, `${server}/`); } catch { throw new ClientUpdateError("check"); }
  if (url.origin !== new URL(server).origin || url.username || url.password || url.search || url.hash ||
    url.pathname !== `/api/client-releases/android/${release.sha256.toLowerCase()}.apk`)
    throw new ClientUpdateError("check");
  return url.href;
}

export function parseClientReleases(value: unknown, server: string): ClientReleases {
  if (!value || typeof value !== "object") throw new ClientUpdateError("check");
  const releases = value as ClientReleases;
  if (releases.android !== null) {
    const release = releases.android;
    if (!release || typeof release !== "object" ||
      typeof release.version_name !== "string" || !release.version_name.trim() || release.version_name.length > 2048 ||
      Array.from(release.version_name).length > 1024 || /[\0\r\n]/.test(release.version_name) ||
      !Number.isSafeInteger(release.version_code) || release.version_code < 1 ||
      !Number.isSafeInteger(release.size_bytes) || release.size_bytes < 1 ||
      typeof release.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(release.sha256) ||
      typeof release.download_url !== "string" ||
      typeof release.published_at !== "string" || !Number.isFinite(Date.parse(release.published_at)) ||
      typeof release.release_notes !== "string" || release.release_notes.length > 20000)
      throw new ClientUpdateError("check");
    androidDownloadURL(server, release);
  }
  if (releases.ios !== null) {
    if (!releases.ios || typeof releases.ios !== "object") throw new ClientUpdateError("check");
    iosDistributionURL(releases.ios.url);
  }
  return releases;
}

let downloadSequence = 0;
function cacheDirectory() {
  if (!FileSystem.cacheDirectory) throw new ClientUpdateError("download");
  return `${FileSystem.cacheDirectory}client-updates/`;
}
const fileURI = (path: string) => `file://${path}`;
const ensureActive = (signal: AbortSignal) => {
  if (signal.aborted) throw new Error("Cancelled");
};

async function verify(path: string, release: AndroidClientRelease, signal: AbortSignal) {
  ensureActive(signal);
  const info = await FileSystem.getInfoAsync(fileURI(path));
  if (!info.exists || info.size !== release.size_bytes) throw new ClientUpdateError("integrity");
  const digest = await BlobUtil.fs.hash(path, "sha256");
  ensureActive(signal);
  if (digest.toLowerCase() !== release.sha256.toLowerCase()) throw new ClientUpdateError("integrity");
  let archive: InstalledClientVersion;
  let installed: InstalledClientVersion;
  try { [archive, installed] = await Promise.all([installer().inspectApk(path), installer().getInstalledVersion()]); }
  catch { throw new ClientUpdateError("package"); }
  ensureActive(signal);
  if (archive.packageName !== installed.packageName || archive.versionCode !== release.version_code ||
    archive.versionName !== release.version_name || archive.versionCode <= installed.versionCode)
    throw new ClientUpdateError("package");
}

async function download(
  server: string, release: AndroidClientRelease, signal: AbortSignal,
  progress: (received: number) => void, verifying: () => void,
) {
  const url = androidDownloadURL(server, release);
  ensureActive(signal);
  const directory = `${cacheDirectory()}${Date.now()}-${++downloadSequence}/`;
  const uri = `${directory}update.apk`;
  const path = decodeURIComponent(uri.replace(/^file:\/\//, ""));
  let task: ReturnType<typeof BlobUtil.fetch> | undefined;
  let overflow = false;
  const cancel = () => { void task?.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel);
  try {
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
    ensureActive(signal);
    task = BlobUtil.config({
      path, followRedirect: false, trusty: false, overwrite: true, timeout: 600000,
    }).fetch("GET", url, { Accept: "application/vnd.android.package-archive" });
    task.progress({ interval: 250 }, (received) => {
      const bytes = Number(received);
      if (!Number.isFinite(bytes) || signal.aborted) return;
      if (bytes > release.size_bytes) { overflow = true; cancel(); return; }
      progress(bytes);
    });
    const response = await task;
    task = undefined;
    ensureActive(signal);
    const status = response.info().status;
    if (status === 404 || status === 410) throw new ClientReleaseUnavailableError();
    if (status !== 200) throw new ClientUpdateError("download");
    verifying();
    await verify(path, release, signal);
    return path;
  } catch (reason) {
    await FileSystem.deleteAsync(directory, { idempotent: true }).catch(() => undefined);
    if (overflow) throw new ClientUpdateError("integrity");
    throw reason instanceof ClientUpdateError ? reason : new ClientUpdateError("download");
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

export const clientUpdateDriver: ClientUpdateDriver = {
  platform: Platform.OS,
  now: Date.now,
  installed: () => installer().getInstalledVersion(),
  releases: async (server, signal) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, 15000);
    signal.addEventListener("abort", abort);
    try {
      ensureActive(signal);
      const response = await fetch(`${server}/api/client-releases`, {
        credentials: "omit", redirect: "error", signal: controller.signal, headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new ClientUpdateError("check");
      return parseClientReleases(await response.json(), server);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  },
  download, verify,
  remove: async (path) => {
    const uri = fileURI(path);
    const directory = uri.slice(0, uri.lastIndexOf("/") + 1);
    await FileSystem.deleteAsync(directory, { idempotent: true });
  },
  clearCache: () => FileSystem.deleteAsync(cacheDirectory(), { idempotent: true }),
  canInstall: () => installer().canRequestPackageInstalls(),
  openPermissionSettings: () => installer().openInstallPermissionSettings(),
  openInstaller: async (path) => {
    await BlobUtil.android.actionViewIntent(path, "application/vnd.android.package-archive");
  },
  openIOS: async (url) => { await Linking.openURL(iosDistributionURL(url)); },
};
