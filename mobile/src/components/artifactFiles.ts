import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { fileURL, resourceHeaders } from "../lib/api";
import type { Artifact } from "../lib/types";

export function fileSize(bytes: number) {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1048576).toFixed(1)} MB`;
}

export function fileType(file: Artifact) {
  if (/\.svg$/i.test(file.name) || /svg/.test(file.mime_type)) return "html";
  if (/\.html?$/i.test(file.name) || /text\/html/.test(file.mime_type)) return "html";
  if (/^image\//.test(file.mime_type)) return "image";
  if (/\.(md|markdown)$/i.test(file.name)) return "markdown";
  if (/pdf/.test(file.mime_type)) return "pdf";
  if (
    /^text\/|json|javascript|xml/.test(file.mime_type) ||
    /\.(py|go|js|ts|tsx|jsx|css|sh|rs|yml|yaml)$/.test(file.name)
  ) return "code";
  return "binary";
}

export async function shareArtifact(file: Artifact) {
  let temporary = "";
  try {
    if (!(await Sharing.isAvailableAsync())) throw new Error("当前设备无法分享文件");
    if (!FileSystem.cacheDirectory) throw new Error("无法保存文件");
    const local = `${FileSystem.cacheDirectory}ochi-${file.id}-${file.name.replace(/[/\\]/g, "-")}`;
    if (!(await FileSystem.getInfoAsync(local)).exists) {
      temporary = `${local}.download-${Date.now()}`;
      const result = await FileSystem.downloadAsync(fileURL(file), temporary, {
        headers: resourceHeaders(file),
      });
      if (result.status < 200 || result.status >= 300) throw new Error("无法下载文件");
      await FileSystem.moveAsync({ from: temporary, to: local });
      temporary = "";
    }
    // The receiving app may read this immutable cached file after the chooser closes.
    await Sharing.shareAsync(local, { mimeType: file.mime_type, dialogTitle: file.name });
  } finally {
    if (temporary) void FileSystem.deleteAsync(temporary, { idempotent: true }).catch(() => undefined);
  }
}
