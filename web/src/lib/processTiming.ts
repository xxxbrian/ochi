export { formatProcessElapsed } from "../../../shared/i18n/process";

export function processElapsedMilliseconds(createdAt: string | undefined, updatedAt: string | undefined, active: boolean, now: number): number | null {
  const start = Date.parse(createdAt ?? "");
  const updated = Date.parse(updatedAt ?? "");
  const end = active ? Math.max(now, Number.isFinite(updated) ? updated : 0) : updated;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}
