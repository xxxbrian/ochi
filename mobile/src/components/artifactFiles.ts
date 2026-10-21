import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import BlobUtil from "react-native-blob-util";
import { fileURL, getAPIBaseURL, resourceHeaders } from "../lib/api";
import type { Artifact } from "../lib/types";

export function fileSize(bytes: number) {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1048576).toFixed(1)} MB`;
}

export function fileType(file: Artifact) {
  const mime = file.mime_type.toLowerCase().split(";")[0]!.trim();
  if (/\.svg$/i.test(file.name) || mime === "image/svg+xml") return "html";
  if (/\.html?$/i.test(file.name) || mime === "text/html") return "html";
  if (/^image\//.test(mime)) return "image";
  if (/\.(md|markdown)$/i.test(file.name)) return "markdown";
  if (mime === "application/pdf" || /\.pdf$/i.test(file.name)) return "pdf";
  if (
    /^text\//.test(mime) || /^application\/(?:[\w.+-]+\+)?(?:json|xml)$/.test(mime) ||
    /^application\/(?:x-)?(?:javascript|ecmascript)$/.test(mime) ||
    /\.(txt|csv|log|json|xml|py|go|js|ts|tsx|jsx|css|sh|rs|yml|yaml)$/i.test(file.name)
  ) return "code";
  return "binary";
}

export type LocalArtifact = { uri: string; dispose: () => Promise<void> };
let downloadSequence = 0;
class ArtifactFileError extends Error {}

async function artifactDestination(file: Artifact): Promise<LocalArtifact> {
  if (!FileSystem.cacheDirectory) throw new ArtifactFileError("无法保存文件");
  const directory = `${FileSystem.cacheDirectory}ochi-artifact-${Date.now()}-${++downloadSequence}`;
  const safe = file.name.replace(/[<>:"/\\|?*\u0000-\u001f\uD800-\uDFFF]/gu, "-").trim();
  const extension = safe.match(/\.[a-z0-9]{1,10}$/i)?.[0] ?? "";
  // Bound UTF-8 filename bytes without cutting a code point or dropping its extension.
  let name = Array.from(safe.slice(0, safe.length - extension.length)).slice(0, 54).join("") + extension;
  if (!name || name === "." || name === "..") name = "file";
  if (fileType(file) === "pdf" && !/\.pdf$/i.test(name)) name += ".pdf";
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  return {
    uri: `${directory}/${encodeURIComponent(name)}`,
    dispose: () => FileSystem.deleteAsync(directory, { idempotent: true }),
  };
}

function artifactURL(value: string, base?: string) {
  let url: URL;
  try { url = new URL(value, base); }
  catch { throw new ArtifactFileError("文件地址无效"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new ArtifactFileError("文件地址无效");
  return url;
}

/** Download to a per-open private file; the native PDF renderer never receives credentials. */
export async function downloadArtifact(file: Artifact, signal?: AbortSignal): Promise<LocalArtifact> {
  const original = artifactURL(fileURL(file));
  const server = getAPIBaseURL();
  const headers = resourceHeaders(file);
  const credentials = JSON.stringify(headers);
  const checkActive = () => {
    if (signal?.aborted || getAPIBaseURL() !== server || JSON.stringify(resourceHeaders(file)) !== credentials)
      throw new ArtifactFileError("文件请求已取消");
  };
  checkActive();
  const local = await artifactDestination(file);
  let task: ReturnType<typeof BlobUtil.fetch> | undefined;
  const cancel = () => { void task?.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", cancel);
  try {
    let url = original;
    for (let redirects = 0; redirects <= 5; redirects++) {
      checkActive();
      // Do not let the HTTP implementation carry bearer headers across a redirect.
      task = BlobUtil.config({ path: decodeURIComponent(local.uri.replace(/^file:\/\//, "")), followRedirect: false, trusty: false, overwrite: true, timeout: 60000 })
        .fetch("GET", url.href, url.origin === original.origin ? headers : {});
      const response = await task;
      task = undefined;
      checkActive();
      const info = response.info();
      if ([301, 302, 303, 307, 308].includes(info.status)) {
        const location = Object.entries(info.headers).find(([name]) => name.toLowerCase() === "location")?.[1];
        if (!location || redirects === 5) throw new ArtifactFileError("无法下载文件，请检查文件地址");
        const next = artifactURL(String(location), url.href);
        if (url.protocol === "https:" && next.protocol !== "https:") throw new ArtifactFileError("文件地址不支持安全连接");
        url = next;
        continue;
      }
      if (info.status < 200 || info.status >= 300) throw new ArtifactFileError("无法下载文件，请重试");
      return local;
    }
    throw new ArtifactFileError("无法下载文件，请重试");
  } catch (reason) {
    await local.dispose().catch(() => undefined);
    if (signal?.aborted) throw new ArtifactFileError("文件请求已取消");
    // Native transport errors can contain private URLs; keep those out of the UI.
    throw reason instanceof ArtifactFileError ? reason : new ArtifactFileError("无法下载文件，请重试");
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

export async function shareArtifact(file: Artifact, localURI?: string) {
  if (!(await Sharing.isAvailableAsync())) throw new Error("当前设备无法分享文件");
  const local = localURI ? await artifactDestination(file) : await downloadArtifact(file);
  try {
    if (localURI) await FileSystem.copyAsync({ from: localURI, to: local.uri });
    await Sharing.shareAsync(local.uri, { mimeType: file.mime_type, dialogTitle: file.name });
    // The receiving app can read this immutable cache file after the chooser closes.
  } catch (reason) {
    await local.dispose().catch(() => undefined);
    throw reason instanceof ArtifactFileError ? reason : new ArtifactFileError("无法分享文件，请重试");
  }
}
