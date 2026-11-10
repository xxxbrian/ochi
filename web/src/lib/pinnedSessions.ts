import { useCallback, useSyncExternalStore } from "react";

// Pinning is a per-browser preference: the server has no pinned flag, so the rail pins are stored locally per account.
const key = (userId: string) => `assistant.pinned.v1.${userId}`;
const listeners = new Set<() => void>();
const cache = new Map<string, { raw: string | null; ids: string[] }>();

function read(userId: string): string[] {
  let raw: string | null = null;
  try { raw = localStorage.getItem(key(userId)); } catch { /* Storage is optional. */ }
  const hit = cache.get(userId);
  if (hit && hit.raw === raw) return hit.ids;
  let ids: string[] = [];
  try { const parsed = raw ? JSON.parse(raw) : []; if (Array.isArray(parsed)) ids = parsed.filter((id): id is string => typeof id === "string"); } catch { /* Corrupt value: start empty. */ }
  cache.set(userId, { raw, ids });
  return ids;
}
function write(userId: string, ids: string[]) {
  try { localStorage.setItem(key(userId), JSON.stringify(ids)); } catch { /* Storage is optional. */ }
  listeners.forEach((fn) => fn());
}
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

export function usePinnedSessions(userId: string) {
  const ids = useSyncExternalStore(subscribe, () => read(userId), () => []);
  const toggle = useCallback((id: string) => {
    const current = read(userId);
    write(userId, current.includes(id) ? current.filter((item) => item !== id) : [id, ...current]);
  }, [userId]);
  const forget = useCallback((id: string) => {
    const current = read(userId);
    if (current.includes(id)) write(userId, current.filter((item) => item !== id));
  }, [userId]);
  return { pinned: ids, toggle, forget };
}
