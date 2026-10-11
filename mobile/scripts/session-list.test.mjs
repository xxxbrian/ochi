import assert from 'node:assert/strict';
import test from 'node:test';
import { appendSessionPage, createSessionListCache, mergeFirstSessionPage, sessionActivity } from '../src/lib/sessionList.ts';

const session = (rank, patch = {}) => ({
  id: `session-${String(rank).padStart(3, '0')}`, title: `Conversation ${rank}`, computer_enabled: false,
  created_at: '2030-01-01T00:00:00Z', updated_at: new Date(Date.UTC(2030, 0, 1) - rank * 1000).toISOString(), ...patch,
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const page = { items: [session(1), session(2)], next_cursor: 'cursor-2' };

test('login prefetch is retained for a later drawer and concurrent refreshes share one request', async () => {
  const response = deferred();
  let requests = 0;
  const cache = createSessionListCache(() => { requests += 1; return response.promise; });
  const first = cache.refresh();
  assert.equal(first, cache.refresh());
  response.resolve(page);
  await first;
  assert.equal(requests, 1);
  const snapshot = cache.getSnapshot();
  assert.deepEqual(snapshot.page, page);
  assert.equal(snapshot.refreshing, false);
  const unsubscribe = cache.subscribe(() => {});
  unsubscribe();
  assert.equal(cache.getSnapshot().page, snapshot.page);
});

test('same response preserves page/row identity while real run-state changes update the affected row', async () => {
  let next = page;
  const cache = createSessionListCache(async () => next);
  await cache.refresh();
  const first = cache.getSnapshot().page;
  next = structuredClone(page);
  await cache.refresh();
  assert.equal(cache.getSnapshot().page, first);
  next = { ...page, items: [session(1, { run_status: 'running' }), session(2)] };
  await cache.refresh();
  assert.notEqual(cache.getSnapshot().page.items[0], first.items[0]);
  assert.equal(cache.getSnapshot().page.items[1], first.items[1]);
});

test('quiet refresh failure keeps already visible sessions', async () => {
  let fail = false;
  const cache = createSessionListCache(async () => { if (fail) throw new Error('Network unavailable'); return page; });
  await cache.refresh();
  const retained = cache.getSnapshot().page;
  fail = true;
  assert.equal(await cache.refresh(), null);
  assert.equal(cache.getSnapshot().page, retained);
  assert.equal(cache.getSnapshot().error, 'Network unavailable');
  assert.equal(cache.getSnapshot().refreshing, false);
});

test('background/auth cancellation rejects late success or failure and does not cancel a new refresh', async () => {
  for (const rejectOld of [false, true]) {
    const old = deferred();
    const fresh = deferred();
    const signals = [];
    const cache = createSessionListCache((signal) => { signals.push(signal); return signals.length === 1 ? old.promise : fresh.promise; });
    const first = cache.refresh();
    await Promise.resolve();
    cache.cancel();
    assert.equal(signals[0].aborted, true);
    const second = cache.refresh();
    await Promise.resolve();
    if (rejectOld) old.reject(new Error('Old account failed'));
    else old.resolve(page);
    await first;
    assert.equal(cache.getSnapshot().page, null);
    assert.equal(cache.getSnapshot().error, '');
    assert.equal(cache.getSnapshot().refreshing, true);
    assert.equal(second, cache.refresh());
    const latest = { items: [session(3)], next_cursor: 'new-cursor' };
    fresh.resolve(latest);
    await second;
    assert.deepEqual(cache.getSnapshot().page, latest);
  }
});

test('cancellation before the load microtask does not dispatch a request under new credentials', async () => {
  let requests = 0;
  const cache = createSessionListCache(async () => { requests += 1; return page; });
  const refresh = cache.refresh();
  cache.cancel();
  await refresh;
  assert.equal(requests, 0);
});

test('separate authenticated-owner caches never reuse each other\'s data', async () => {
  const first = createSessionListCache(async () => page);
  const second = createSessionListCache(async () => ({ items: [session(9)] }));
  await first.refresh();
  assert.equal(second.getSnapshot().page, null);
  await second.refresh();
  assert.equal(first.getSnapshot().page.items[0].id, session(1).id);
  assert.equal(second.getSnapshot().page.items[0].id, session(9).id);
});

test('new first-page rows retain displaced boundary rows, all loaded tail rows, and the original paging cursor', () => {
  const items = Array.from({ length: 80 }, (_, index) => session(index + 1));
  const current = { items, paged: true, cursor: 'cursor-80' };
  const refreshed = mergeFirstSessionPage(current, { items: [session(0), ...items.slice(0, 39)], next_cursor: 'cursor-39' });
  assert.equal(refreshed.cursor, 'cursor-80');
  assert.equal(refreshed.paged, true);
  assert.equal(refreshed.items.length, 81);
  assert.equal(refreshed.items[40], items[39]);
  assert.equal(refreshed.items.at(-1), items[79]);
});

test('a tail conversation promoted into the first page appears once without losing displaced rows', () => {
  const items = Array.from({ length: 80 }, (_, index) => session(index + 1));
  const promoted = { ...items[59], updated_at: '2030-01-01T00:00:01Z', run_status: 'running' };
  const refreshed = mergeFirstSessionPage({ items, paged: true, cursor: 'cursor-80' }, { items: [promoted, ...items.slice(0, 39)], next_cursor: 'cursor-39' });
  assert.equal(refreshed.items.length, 80);
  assert.equal(refreshed.items.filter((item) => item.id === promoted.id).length, 1);
  assert.equal(refreshed.items.find((item) => item.id === items[39].id), items[39]);
  assert.equal(refreshed.cursor, 'cursor-80');
});

test('authoritative complete pages remove stale rows and end paging', () => {
  const items = Array.from({ length: 50 }, (_, index) => session(index + 1));
  const refreshed = mergeFirstSessionPage({ items, paged: true, cursor: 'cursor-50' }, { items: [session(1)] });
  assert.deepEqual(refreshed.items, [session(1)]);
  assert.equal(refreshed.cursor, undefined);
  assert.equal(refreshed.paged, false);
});

test('missing rows inside the fully covered fresh first-page window are deleted, not retained as stale sessions', () => {
  const items = Array.from({ length: 80 }, (_, index) => session(index + 1));
  const next = items.slice(0, 41).filter((item) => item.id !== session(10).id);
  const refreshed = mergeFirstSessionPage({ items, paged: true, cursor: 'cursor-80' }, { items: next, next_cursor: 'cursor-41' });
  assert.equal(refreshed.items.some((item) => item.id === session(10).id), false);
  assert.equal(refreshed.items.length, 79);
  assert.equal(refreshed.cursor, 'cursor-80');
});

test('nanosecond sort boundaries and equal timestamp ID ties preserve correctly ordered older rows', () => {
  const newer = session(1, { updated_at: '2030-01-01T00:00:00.000000009Z' });
  const older = session(2, { updated_at: '2030-01-01T00:00:00.000000001Z' });
  const sameTimeSmaller = session(0, { updated_at: newer.updated_at });
  const current = { items: [newer, sameTimeSmaller, older], paged: true, cursor: 'original' };
  const next = mergeFirstSessionPage(current, { items: [newer], next_cursor: 'first-page' });
  assert.deepEqual(next.items, [newer, sameTimeSmaller, older]);
});

test('paging deduplicates live-update overlap and advances only to the response cursor', () => {
  const current = { items: [session(1), session(2)], paged: false, cursor: 'cursor-2' };
  const next = appendSessionPage(current, { items: [session(2), session(3)], next_cursor: 'cursor-3' });
  assert.equal(next.items.length, 3);
  assert.equal(next.items[1], current.items[1]);
  assert.equal(next.cursor, 'cursor-3');
});

test('exact local rename/delete mutations prevent an older in-flight result from resurrecting old data', async () => {
  const old = deferred();
  let first = true;
  const cache = createSessionListCache(() => { if (first) { first = false; return Promise.resolve(page); } return old.promise; });
  await cache.refresh();
  const refresh = cache.refresh();
  await Promise.resolve();
  cache.updateSession({ ...page.items[0], title: 'Renamed' });
  cache.removeSession(page.items[1].id);
  old.resolve(page);
  await refresh;
  assert.equal(cache.getSnapshot().page.items.length, 1);
  assert.equal(cache.getSnapshot().page.items[0].title, 'Renamed');
});

test('deleting a loaded tail row cancels a pending promotion even when it is absent from the cached first page', async () => {
  const response = deferred();
  let initial = true;
  const cache = createSessionListCache(() => { if (initial) { initial = false; return Promise.resolve(page); } return response.promise; });
  await cache.refresh();
  const firstPage = cache.getSnapshot().page;
  const refresh = cache.refresh();
  await Promise.resolve();
  cache.removeSession(session(50).id);
  response.resolve({ items: [session(50), ...page.items], next_cursor: 'stale-promoted' });
  await refresh;
  assert.equal(cache.getSnapshot().page, firstPage);
  assert.equal(cache.getSnapshot().page.items.some((item) => item.id === session(50).id), false);
});

test('run badges derive from real server state, distinguish waiting states, and clear after completion', () => {
  assert.equal(sessionActivity(session(1)), null);
  for (const status of ['running', 'cancelling']) assert.equal(sessionActivity(session(1, { run_status: status })).spinning, true);
  for (const status of ['waiting_user', 'waiting_resource', 'queued']) assert.equal(sessionActivity(session(1, { run_status: status })).spinning, false);
  assert.equal(sessionActivity(session(1, { run_status: 'completed' })), null);
  assert.equal(sessionActivity(session(1, { run_status: 'completed', queued_count: 2 })).label, '2 条待处理');
});
