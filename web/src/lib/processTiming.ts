import { processT as t } from "../../../shared/i18n/process";

export function processElapsedMilliseconds(createdAt: string | undefined, updatedAt: string | undefined, active: boolean, now: number): number | null {
  const start = Date.parse(createdAt ?? "");
  const updated = Date.parse(updatedAt ?? "");
  const end = active ? Math.max(now, Number.isFinite(updated) ? updated : 0) : updated;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

export function formatProcessElapsed(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  if (seconds < 60) return t("duration.seconds", { seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("duration.minutesSeconds", { minutes, seconds: seconds % 60 });
  return t("duration.hoursMinutes", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}
