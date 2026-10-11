import type { Session, SessionPage } from './types';

export type SessionListSnapshot = {
  page: SessionPage | null;
  refreshing: boolean;
  error: string;
};

export function createSessionListCache(load: (signal: AbortSignal) => Promise<SessionPage>) {
  let snapshot: SessionListSnapshot = { page: null, refreshing: false, error: '' };
  let generation = 0;
  let pending: { controller: AbortController; promise: Promise<SessionPage | null> } | null = null;
  const listeners = new Set<() => void>();
  const publish = (value: SessionListSnapshot) => {
    snapshot = value;
    listeners.forEach((listener) => listener());
  };

  function cancel() {
    generation += 1;
    pending?.controller.abort();
    pending = null;
    if (snapshot.refreshing) publish({ ...snapshot, refreshing: false });
  }

  function refresh() {
    if (pending) return pending.promise;
    const owner = ++generation;
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => owner === generation ? load(controller.signal) : null).then((page) => {
      if (!page || owner !== generation) return null;
      const previous = snapshot.page;
      const items = stableSessionItems(previous?.items ?? [], page.items ?? []);
      const unchanged = previous && previous.next_cursor === page.next_cursor &&
        previous.items.length === items.length && items.every((item, index) => item === previous.items[index]);
      const next = unchanged ? previous : { ...page, items };
      publish({ page: next, refreshing: false, error: '' });
      return next;
    }).catch((reason: unknown) => {
      if (owner === generation) publish({ ...snapshot, refreshing: false, error: reason instanceof Error ? reason.message : '加载失败' });
      return null;
    }).finally(() => {
      if (owner === generation) pending = null;
    });
    pending = { controller, promise };
    publish({ ...snapshot, refreshing: true });
    return promise;
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh,
    cancel,
    updateSession: (session: Session) => {
      const existing = snapshot.page?.items.find((item) => item.id === session.id);
      if (existing && existing.title === session.title && existing.title_source === session.title_source && existing.updated_at === session.updated_at) return;
      cancel();
      if (!snapshot.page || !existing) return;
      publish({ ...snapshot, page: { ...snapshot.page, items: snapshot.page.items.map((item) => item.id === session.id ? {
        ...item, title: session.title, title_source: session.title_source, updated_at: session.updated_at,
      } : item) } });
    },
    removeSession: (id: string) => {
      cancel();
      if (snapshot.page?.items.some((item) => item.id === id)) publish({ ...snapshot, page: { ...snapshot.page, items: snapshot.page.items.filter((item) => item.id !== id) } });
    },
  };
}

export type SessionListCache = ReturnType<typeof createSessionListCache>;
export type DrawerSessionList = { items: Session[]; cursor?: string; paged: boolean };

function stableSessionItems(previous: Session[], next: Session[]) {
  const existing = new Map(previous.map((item) => [item.id, item]));
  return next.map((item) => {
    const retained = existing.get(item.id);
    return retained && JSON.stringify(retained) === JSON.stringify(item) ? retained : item;
  });
}

function timeKey(value: string) {
  // Match PostgreSQL's nanosecond timestamp ordering without losing fractions in Date.parse.
  return value.replace(/(?:\.(\d+))?Z$/, (_match, fraction: string | undefined) => `.${(fraction ?? '').padEnd(9, '0')}Z`);
}

function isOlder(item: Session, boundary: Session) {
  const time = timeKey(item.updated_at);
  const after = timeKey(boundary.updated_at);
  return time < after || (time === after && item.id < boundary.id);
}

export function mergeFirstSessionPage(current: DrawerSessionList, page: SessionPage): DrawerSessionList {
  const items = stableSessionItems(current.items, page.items ?? []);
  const boundary = items.at(-1);
  if (!current.paged || !page.next_cursor || !boundary) return { items, cursor: page.next_cursor, paged: false };
  const ids = new Set(items.map((item) => item.id));
  // Keep already loaded older pages and displaced boundary rows, not deleted rows in the new first page.
  const tail = current.items.filter((item) => !ids.has(item.id) && isOlder(item, boundary));
  return { items: [...items, ...tail], cursor: current.cursor, paged: true };
}

export function appendSessionPage(current: DrawerSessionList, page: SessionPage): DrawerSessionList {
  const ids = new Set(current.items.map((item) => item.id));
  return { items: [...current.items, ...(page.items ?? []).filter((item) => !ids.has(item.id))], cursor: page.next_cursor, paged: true };
}

export function sessionActivity(session: Session): { label: string; spinning: boolean } | null {
  switch (session.run_status ?? session.latest_run?.status) {
    case 'running': return { label: '正在运行', spinning: true };
    case 'cancelling': return { label: '正在停止', spinning: true };
    case 'waiting_user': return { label: '等待回复', spinning: false };
    case 'waiting_resource': return { label: '等待资源', spinning: false };
    case 'queued': return { label: '排队中', spinning: false };
    default: return session.queued_count ? { label: `${session.queued_count} 条待处理`, spinning: false } : null;
  }
}
