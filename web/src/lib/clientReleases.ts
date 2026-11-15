import { API_BASE } from "./api";
import { getLocale } from "./i18n";
import type { AndroidClientRelease } from "./types";

export function androidReleaseURL(release: AndroidClientRelease): string | undefined {
  return /^[a-f0-9]{64}$/.test(release.sha256) &&
    release.download_url === `/api/client-releases/android/${release.sha256}.apk`
    ? `${API_BASE}${release.download_url}` : undefined;
}

export function iosReleaseURL(value: string): string | undefined {
  try {
    const url = new URL(value);
    return value.length <= 2048 && url.protocol === "https:" && !url.username && !url.password
      ? url.href : undefined;
  } catch { return undefined; }
}

export function releaseSize(bytes: number): string {
  return `${new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 1 }).format(bytes / 1048576)} MB`;
}
