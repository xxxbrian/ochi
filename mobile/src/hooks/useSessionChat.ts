import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { api, isActiveStatus } from '../lib/api';
import { useApp } from '../providers/AppProvider';
import { useRunStream } from './useRunStream';
import type { Artifact, Message, PendingRun, RunOptions, Session, SessionPatch, Snapshot } from '../lib/types';

function mergeHistory(current: Message[], recent: Message[], preserveOlder: boolean) {
  // A short window is the complete canonical history, including remote revisions.
  if (!preserveOlder || recent.length < 100) return recent;
  const ids = new Set(recent.map((message) => message.id));
  const first = recent[0];
  if (!first) return recent;
  const boundary = current.findIndex((message) => message.id === first.id);
  // Go emits RFC3339Nano: pad UTC fractions before comparing an unseen boundary.
  const timeKey = (value: string) => value.replace(/(?:\.(\d+))?Z$/, (_match, fraction: string | undefined) => `.${(fraction ?? '').padEnd(9, '0')}Z`);
  const firstTime = timeKey(first.created_at);
  const prefix = boundary >= 0 ? current.slice(0, boundary) : current.filter((message) => {
    const time = timeKey(message.created_at);
    return time < firstTime || (time === firstTime && message.id < first.id);
  });
  const older = prefix.filter((message) => !ids.has(message.id) && !message.id.startsWith('pending-'));
  return [...older, ...recent];
}

type SessionScope = { id?: string };
type SyncFlight = { scope: SessionScope; revision: number; full: boolean; repeat: boolean; promise: Promise<void> };
type HistoryRevision = Pick<Snapshot, 'run_id' | 'seq' | 'status'> | null;

function sessionListKey(value: Session | null) {
  if (!value) return '';
  return JSON.stringify([value.id, value.title, value.title_source, value.updated_at, value.model_id,
    value.effort, value.project_id, value.computer_enabled, value.run_status, value.active_run_id, value.queued_count]);
}

function needsHistory(previous: HistoryRevision, latest: Snapshot | null | undefined) {
  if (!previous || !latest) return Boolean(previous) !== Boolean(latest);
  if (previous.run_id !== latest.run_id) return true;
  // Active deltas belong to SSE; only a new turn or committed terminal version changes history.
  return !isActiveStatus(latest.status) && (previous.status !== latest.status || previous.seq !== latest.seq);
}

export function useSessionChat(sessionId?: string, focused = true) {
  const { invalidateLists } = useApp();
  const generation = useRef(0);
  const mounted = useRef(true);
  const routeId = useRef(sessionId);
  const selected = useRef<SessionScope>({ id: sessionId });
  const adopted = useRef<{ scope: SessionScope; previousId?: string } | null>(null);
  const acknowledged = useRef<SessionScope | null>(null);
  const streamScope = useRef<SessionScope | null>(null);
  const olderLoaded = useRef(false);
  const historyRevision = useRef(0);
  const loadingRef = useRef<{ scope: SessionScope } | null>(null);
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const syncRevision = useRef(0);
  const syncFlight = useRef<SyncFlight | null>(null);
  const sendingScope = useRef<SessionScope | null>(null);
  const synced = useRef<{ scope: SessionScope; session: Session; history: HistoryRevision } | null>(null);
  if (routeId.current !== sessionId) {
    const previousId = routeId.current;
    routeId.current = sessionId;
    // Adoption lasts only until Router acknowledges the accepted first turn.
    if (adopted.current && adopted.current.scope.id === sessionId && adopted.current.previousId === previousId) {
      acknowledged.current = adopted.current.scope;
    } else {
      selected.current = { id: sessionId };
      generation.current += 1;
      streamScope.current = null;
      olderLoaded.current = false;
      loadingRef.current = null;
      acknowledged.current = null;
      syncRevision.current += 1;
    }
    adopted.current = null;
  }
  const scope = selected.current;
  const [stateScope, setStateScope] = useState(scope);
  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [pending, setPending] = useState<PendingRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [posting, setPosting] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const [error, setError] = useState('');
  const runRef = useRef<Snapshot | null>(null);
  const followRef = useRef<(snapshot: Snapshot) => void>(() => undefined);
  const historyRef = useRef(messages);
  const ownsState = stateScope === scope;
  historyRef.current = ownsState ? messages : [];
  const isCurrent = useCallback((owner: SessionScope, token = generation.current) =>
    mounted.current && selected.current === owner && generation.current === token, []);

  const synchronize = useCallback((full: boolean): Promise<void> => {
    const owner = selected.current;
    const currentId = owner.id;
    if (!currentId || sendingScope.current === owner) return Promise.resolve();
    if (!full && (!focusedRef.current || AppState.currentState !== 'active')) return Promise.resolve();
    const existing = syncFlight.current;
    if (existing?.scope === owner) {
      if (full && (!existing.full || existing.revision !== syncRevision.current)) existing.repeat = true;
      return existing.promise;
    }
    const token = generation.current;
    const flight: SyncFlight = { scope: owner, revision: syncRevision.current, full, repeat: false, promise: Promise.resolve() };
    syncFlight.current = flight;
    flight.promise = (async () => {
      do {
        flight.full ||= flight.repeat;
        flight.repeat = false;
        flight.revision = syncRevision.current;
        const revision = flight.revision;
        const valid = () => isCurrent(owner, token) && revision === syncRevision.current;
        try {
          const value = await api.session(currentId);
          if (!valid() || value.id !== currentId) continue;
          const previous = synced.current?.scope === owner ? synced.current : null;
          const loadHistory = flight.full || !previous || needsHistory(previous.history, value.latest_run);
          const loadQueue = flight.full || !previous || Boolean(value.queued_count) || previous.session.queued_count !== value.queued_count;
          const [recent, queue] = await Promise.all([
            loadHistory ? api.messages(currentId) : Promise.resolve(null),
            loadQueue ? api.queue(currentId) : Promise.resolve(null),
          ]);
          if (!valid()) continue;
          const changed = sessionListKey(previous?.session ?? null) !== sessionListKey(value);
          if (!previous) setError('');
          if (changed || loadHistory) setSession(value);
          if (recent) {
            if ((previous && needsHistory(previous.history, value.latest_run)) || (recent.length < 100 && historyRef.current.length >= 100)) {
              historyRevision.current += 1;
              loadingRef.current = null;
              setLoadingOlder(false);
            }
            setMessages((current) => {
              const merged = mergeHistory(current, recent, olderLoaded.current);
              return JSON.stringify(current) === JSON.stringify(merged) ? current : merged;
            });
            if (recent.length < 100) { olderLoaded.current = false; setHasOlder(false); }
            else if (!olderLoaded.current) setHasOlder(true);
          }
          if (queue) setPending((current) => JSON.stringify(current) === JSON.stringify(queue) ? current : queue);
          synced.current = { scope: owner, session: value, history: loadHistory ? (value.latest_run ?? null) : previous?.history ?? null };
          const latest = value.latest_run;
          if (latest && (latest.run_id !== runRef.current?.run_id || latest.seq > runRef.current.seq)) followRef.current(latest);
          if (previous && changed) invalidateLists();
          flight.full = true;
        } catch (reason) {
          if (valid()) throw reason;
        }
      } while (flight.repeat && isCurrent(owner, token) && focusedRef.current && AppState.currentState === 'active' && sendingScope.current !== owner);
    })().finally(() => { if (syncFlight.current === flight) syncFlight.current = null; });
    return flight.promise;
  }, [invalidateLists, isCurrent]);

  const refresh = useCallback(() => synchronize(true), [synchronize]);
  const onTerminal = useCallback((snapshot: Snapshot) => {
    if (streamScope.current !== selected.current || snapshot.session_id !== selected.current.id) return;
    // A full request already in flight may predate the persisted terminal message.
    syncRevision.current += 1;
    void refresh().catch(() => undefined);
  }, [refresh]);
  const { snapshot: rawRun, reconnecting: rawReconnecting, follow: followRun, clear } = useRunStream(onTerminal, () => {
    if (streamScope.current === selected.current && runRef.current?.session_id === selected.current.id) {
      setError('请重新登录');
      void api.me().catch(() => undefined);
    }
  }, focused);
  const follow = useCallback((snapshot: Snapshot, owner = selected.current) => {
    if (!isCurrent(owner) || snapshot.session_id !== owner.id) return;
    streamScope.current = owner;
    followRun(snapshot);
  }, [followRun, isCurrent]);
  // Route changes mask stale state in this render, before passive cleanup runs.
  const run = streamScope.current === scope && rawRun?.session_id === scope.id ? rawRun : null;
  const reconnecting = Boolean(run && rawReconnecting);
  runRef.current = run;
  followRef.current = follow;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current += 1; };
  }, []);

  useEffect(() => {
    if (adopted.current?.scope === scope) return;
    if (acknowledged.current === scope) {
      acknowledged.current = null;
      void refresh().catch(() => undefined);
      return;
    }
    const token = generation.current;
    streamScope.current = null;
    clear(); setSession(null); setMessages([]); setPending([]); setError(''); setHasOlder(false);
    setStateScope(scope);
    olderLoaded.current = false;
    loadingRef.current = null;
    synced.current = null;
    sendingScope.current = null;
    setPosting(false); setLoadingOlder(false);
    if (!scope.id) { setLoading(false); return; }
    setLoading(true);
    if (!focusedRef.current || AppState.currentState !== 'active') return;
    void refresh().catch((reason) => { if (isCurrent(scope, token)) setError(reason instanceof Error ? reason.message : '加载失败'); })
      .finally(() => { if (isCurrent(scope, token)) setLoading(false); });
  }, [sessionId, scope, clear, refresh, isCurrent]);

  const acceptCreated = useCallback((value: Session, snapshot: Snapshot | null, input: { content: string; attachments?: Artifact[] }) => {
    if (!isCurrent(scope) || scope.id || (snapshot && snapshot.session_id !== value.id)) return false;
    generation.current += 1;
    syncRevision.current += 1;
    const acceptedScope: SessionScope = { id: value.id };
    adopted.current = { scope: acceptedScope, previousId: sessionId };
    selected.current = acceptedScope;
    streamScope.current = null;
    setStateScope(acceptedScope);
    clear();
    setSession(value); setPending([]); setError(''); setHasOlder(false);
    setLoading(false); setPosting(false); setLoadingOlder(false);
    olderLoaded.current = false;
    loadingRef.current = null;
    synced.current = null;
    sendingScope.current = null;
    setMessages(snapshot ? [{
      id: `pending-${snapshot.run_id}`, run_id: snapshot.run_id, role: 'user',
      content: input.content, attachments: input.attachments, created_at: new Date().toISOString(),
    }] : []);
    if (snapshot) follow(snapshot, acceptedScope);
    invalidateLists();
    return true;
  }, [sessionId, scope, clear, follow, invalidateLists, isCurrent]);

  useEffect(() => {
    if (!scope.id || !focused) return;
    const token = generation.current;
    const update = (full: boolean) => {
      if (AppState.currentState !== 'active' || !focusedRef.current || !isCurrent(scope, token)) return;
      void synchronize(full).catch((reason) => {
        if (isCurrent(scope, token) && !synced.current) setError(reason instanceof Error ? reason.message : '加载失败');
      }).finally(() => { if (isCurrent(scope, token)) setLoading(false); });
    };
    if (adopted.current?.scope !== scope) update(true);
    const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') update(true); });
    const timer = setInterval(() => update(false), 4000);
    return () => { subscription.remove(); clearInterval(timer); };
  }, [scope, focused, synchronize, isCurrent]);

  const loadOlder = useCallback(async () => {
    const currentId = scope.id;
    if (!currentId || !isCurrent(scope) || loadingRef.current?.scope === scope || !ownsState || !hasOlder || !historyRef.current[0]) return;
    const request = { scope };
    loadingRef.current = request; setLoadingOlder(true);
    const token = generation.current;
    const revision = historyRevision.current;
    try {
      const older = await api.messages(currentId, historyRef.current[0].id);
      if (!isCurrent(scope, token) || revision !== historyRevision.current) return;
      olderLoaded.current = true;
      setHasOlder(older.length >= 100);
      setMessages((current) => {
        const ids = new Set(current.map((message) => message.id));
        return [...older.filter((message) => !ids.has(message.id)), ...current];
      });
    } finally {
      if (loadingRef.current === request) {
        loadingRef.current = null;
        if (isCurrent(scope, token)) setLoadingOlder(false);
      }
    }
  }, [scope, ownsState, hasOlder, isCurrent]);

  const send = useCallback(async (content: string, options: RunOptions & { attachments?: Artifact[] } = {}) => {
    const currentId = scope.id;
    if (!currentId || !isCurrent(scope)) throw new Error('请先创建对话');
    const token = generation.current;
    const revisedRun = options.retry_run_id ?? (options.edit_message_id
      ? historyRef.current.find((message) => message.id === options.edit_message_id)?.run_id : undefined);
    const optimistic: Message = { id: `pending-${Date.now()}`, role: 'user', content, attachments: options.attachments, created_at: new Date().toISOString() };
    syncRevision.current += 1;
    historyRevision.current += 1;
    loadingRef.current = null;
    setLoadingOlder(false);
    sendingScope.current = scope;
    setPosting(true); setError('');
    setMessages((current) => [...current, optimistic]);
    try {
      const { attachments: _attachments, ...runOptions } = options;
      const result = await api.startRun(currentId, content, runOptions);
      if (!isCurrent(scope, token)) return result;
      syncRevision.current += 1;
      sendingScope.current = null;
      if (result.status === 'queued') {
        setMessages((current) => current.filter((message) => message.id !== optimistic.id));
      } else {
        // A revision archives only the replaced turn; preserve already paged older turns.
        if (revisedRun || options.edit_message_id) setMessages((current) => current.filter((message) =>
          !(revisedRun && message.run_id === revisedRun) && message.id !== options.edit_message_id));
        follow(result, scope);
      }
      // Coalesce with terminal/focus refreshes, replacing the optimistic input with its canonical ID.
      await refresh().catch(() => undefined);
      invalidateLists();
      return result;
    } catch (reason) {
      // The caller's catch handler must not display an old request's error on New.
      if (!isCurrent(scope, token)) return;
      setMessages((current) => current.filter((message) => message.id !== optimistic.id));
      setError(reason instanceof Error ? reason.message : '发送失败');
      throw reason;
    } finally {
      if (sendingScope.current === scope) sendingScope.current = null;
      if (isCurrent(scope, token)) setPosting(false);
    }
  }, [scope, follow, refresh, invalidateLists, isCurrent]);

  const stop = useCallback(async () => {
    const running = runRef.current;
    if (!isCurrent(scope) || !scope.id || running?.session_id !== scope.id) return;
    const token = generation.current;
    syncRevision.current += 1;
    try {
      const result = await api.cancelRun(running.run_id);
      if (!isCurrent(scope, token)) return;
      syncRevision.current += 1;
      follow(result, scope);
      if (!isActiveStatus(result.status)) await refresh();
    } catch (reason) { if (isCurrent(scope, token)) throw reason; }
  }, [scope, follow, refresh, isCurrent]);
  const resume = useCallback(async (answer: string) => {
    const running = runRef.current;
    if (!isCurrent(scope) || !scope.id || running?.session_id !== scope.id) return;
    const token = generation.current;
    syncRevision.current += 1;
    try {
      const result = await api.resumeRun(running.run_id, answer);
      if (!isCurrent(scope, token)) return;
      syncRevision.current += 1;
      follow(result, scope);
      if (!isActiveStatus(result.status)) await refresh();
    } catch (reason) { if (isCurrent(scope, token)) throw reason; }
  }, [scope, follow, refresh, isCurrent]);
  const updateSession = useCallback(async (patch: SessionPatch) => {
    const currentId = scope.id;
    if (!currentId || !isCurrent(scope)) throw new Error('对话不存在');
    const token = generation.current;
    syncRevision.current += 1;
    try {
      const result = await api.updateSession(currentId, patch);
      if (!isCurrent(scope, token)) return result;
      syncRevision.current += 1;
      setSession(result);
      if (result.latest_run) follow(result.latest_run, scope);
      invalidateLists(); return result;
    } catch (reason) { if (isCurrent(scope, token)) throw reason; }
  }, [scope, follow, invalidateLists, isCurrent]);
  const cancelQueued = useCallback(async (runId: string) => {
    const currentId = scope.id;
    if (!currentId || !isCurrent(scope)) return;
    const token = generation.current;
    syncRevision.current += 1;
    try {
      await api.cancelQueuedRun(currentId, runId);
      if (isCurrent(scope, token)) { syncRevision.current += 1; await refresh(); }
    } catch (reason) { if (isCurrent(scope, token)) throw reason; }
  }, [scope, refresh, isCurrent]);
  const updateQueued = useCallback(async (runId: string, message: string) => {
    const currentId = scope.id;
    if (!currentId || !isCurrent(scope)) return;
    const token = generation.current;
    syncRevision.current += 1;
    try {
      await api.updateQueuedRun(currentId, runId, { message });
      if (isCurrent(scope, token)) { syncRevision.current += 1; await refresh(); }
    } catch (reason) { if (isCurrent(scope, token)) throw reason; }
  }, [scope, refresh, isCurrent]);

  return { session: ownsState ? session : null, messages: ownsState ? messages : [], run,
    pending: ownsState ? pending : [], loading: ownsState ? loading : Boolean(scope.id),
    posting: ownsState && posting, loadingOlder: ownsState && loadingOlder, hasOlder: ownsState && hasOlder,
    error: ownsState ? error : '', reconnecting,
    loadOlder, refresh, acceptCreated, send, stop, resume, updateSession, cancelQueued, updateQueued };
}
