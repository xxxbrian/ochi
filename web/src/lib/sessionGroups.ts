import type { Session } from "./types";

export type SessionGroupKey = "today" | "yesterday" | "week" | "older";
const DAY = 86_400_000;
const ORDER: SessionGroupKey[] = ["today", "yesterday", "week", "older"];

/** Buckets sessions by local calendar day of their last update; empty buckets are omitted, input order is kept. */
export function groupSessions(sessions: Session[], now = new Date()): { key: SessionGroupKey; items: Session[] }[] {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const buckets = new Map<SessionGroupKey, Session[]>(ORDER.map((key) => [key, []]));
  for (const session of sessions) {
    const at = Date.parse(session.updated_at);
    const key: SessionGroupKey = !Number.isFinite(at) || at < start - 6 * DAY ? "older" : at >= start ? "today" : at >= start - DAY ? "yesterday" : "week";
    buckets.get(key)!.push(session);
  }
  return ORDER.map((key) => ({ key, items: buckets.get(key)! })).filter((bucket) => bucket.items.length);
}
