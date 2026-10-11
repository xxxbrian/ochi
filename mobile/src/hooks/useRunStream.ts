import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { api, isActiveStatus } from '../lib/api';
import { connectRunStream, type RunEvent } from '../lib/sse';
import type { Snapshot } from '../lib/types';

export { applyRunEvent } from '../lib/runEvents';
import { applyRunEvent } from '../lib/runEvents';

export function useRunStream(onTerminal: (snapshot: Snapshot) => void, onExpired: () => void, enabled = true) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const live = useRef<Snapshot | null>(null);
  const close = useRef<(() => void) | null>(null);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const terminal = useRef(onTerminal);
  const expired = useRef(onExpired);
  terminal.current = onTerminal;
  expired.current = onExpired;

  const disconnect = useCallback(() => {
    generation.current += 1;
    close.current?.(); close.current = null;
    if (flushTimer.current) clearTimeout(flushTimer.current);
    if (retryTimer.current) clearTimeout(retryTimer.current);
    flushTimer.current = retryTimer.current = null;
  }, []);

  const clear = useCallback(() => { disconnect(); live.current = null; setSnapshot(null); setReconnecting(false); }, [disconnect]);
  const follow = useCallback((initial: Snapshot) => {
    const previous = live.current;
    const sameRun = previous?.run_id === initial.run_id && previous.session_id === initial.session_id;
    if (sameRun && previous.seq > initial.seq) return;
    const canConnect = enabledRef.current && AppState.currentState === 'active';
    if (sameRun && isActiveStatus(initial.status)) {
      if (previous.seq !== initial.seq) {
        live.current = { ...initial, steps: initial.steps ?? [] };
        setSnapshot(live.current);
      }
      // Metadata polling must not close a healthy SSE connection or restart its retry backoff.
      if (close.current || retryTimer.current || !canConnect) return;
    } else if (sameRun && previous.seq === initial.seq && !isActiveStatus(initial.status)) return;
    disconnect();
    live.current = { ...initial, steps: initial.steps ?? [] };
    setSnapshot(live.current); setReconnecting(false);
    if (!isActiveStatus(initial.status) || !canConnect) return;
    const token = generation.current;
    let failures = 0;
    let resyncing = false;
    const current = () => token === generation.current && enabledRef.current && AppState.currentState === 'active';
    const flush = () => {
      if (flushTimer.current) clearTimeout(flushTimer.current);
      flushTimer.current = null;
      if (current()) setSnapshot(live.current);
    };
    const complete = () => {
      if (!current()) return;
      flush(); close.current?.(); close.current = null;
      setReconnecting(false);
      if (live.current) terminal.current(live.current);
    };
    const expire = () => { clear(); expired.current(); };
    const scheduleReconnect = () => {
      if (!current() || retryTimer.current) return;
      setReconnecting(true);
      retryTimer.current = setTimeout(() => { retryTimer.current = null; void resync(); }, Math.min(500 * 2 ** failures++, 5000));
    };

    async function resync() {
      if (resyncing || !current()) return;
      resyncing = true;
      close.current?.(); close.current = null;
      setReconnecting(true);
      try {
        const latest = await api.run(initial.run_id);
        if (!current()) return;
        if (!live.current || latest.seq >= live.current.seq) live.current = { ...latest, steps: latest.steps ?? [] };
        flush();
        if (!isActiveStatus(latest.status)) { complete(); return; }
        resyncing = false;
        connect();
      } catch (reason) {
        if (!current()) return;
        if (reason && typeof reason === 'object' && 'status' in reason && reason.status === 401) { expire(); return; }
        resyncing = false;
        scheduleReconnect();
      } finally { resyncing = false; }
    }

    function handle(event: RunEvent) {
      if (!current() || resyncing || event.value.run_id !== initial.run_id) return;
      if (event.kind === 'snapshot') {
        if (event.value.session_id !== initial.session_id || (live.current && event.value.seq < live.current.seq)) return;
        live.current = { ...event.value, steps: event.value.steps ?? [] };
        flush();
      } else {
        if (!live.current || event.value.seq <= live.current.seq) return;
        if (event.value.seq !== live.current.seq + 1) { void resync(); return; }
        live.current = applyRunEvent(live.current, event);
        if (!flushTimer.current) flushTimer.current = setTimeout(flush, 50);
      }
      if (live.current && !isActiveStatus(live.current.status)) complete();
    }

    function connect() {
      if (!current()) return;
      close.current = connectRunStream(api.eventsUrl(initial.run_id), {
        onOpen: () => { if (current()) { setReconnecting(false); failures = 0; } },
        onEvent: handle,
        onClose: (reason) => {
          if (!current()) return;
          close.current = null;
          if (reason?.status === 401) expire();
          else scheduleReconnect();
        },
      });
    }
    connect();
  }, [disconnect, clear]);

  useEffect(() => {
    const resume = () => {
      const running = live.current;
      if (!enabledRef.current || AppState.currentState !== 'active' || !running || !isActiveStatus(running.status)) return;
      // Every subscription starts with an authoritative snapshot, so no extra foreground GET is needed.
      follow(running);
    };
    if (!enabled) { disconnect(); setSnapshot(live.current); setReconnecting(false); }
    else resume();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') { disconnect(); setSnapshot(live.current); setReconnecting(false); return; }
      resume();
    });
    return () => { subscription.remove(); disconnect(); };
  }, [enabled, disconnect, follow]);

  return { snapshot, reconnecting, follow, clear };
}
