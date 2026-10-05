import { useCallback, useEffect, useRef, useState } from "react";
import { api, isActiveStatus } from "../lib/api";
import { parseRunEvent } from "../lib/sse";
import { reduceRunDelta } from "../lib/runReducer";
import type { Snapshot } from "../lib/types";

// Snapshots replace local state; only the live reply is published every 50ms.
export function useRunStream(
  onTerminal: (snapshot: Snapshot) => void,
  onExpired: () => void,
) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const live = useRef<Snapshot | null>(null);
  const source = useRef<EventSource | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0);
  const terminalCallback = useRef(onTerminal);
  const expiredCallback = useRef(onExpired);
  terminalCallback.current = onTerminal;
  expiredCallback.current = onExpired;

  const disconnect = useCallback(() => {
    generation.current += 1;
    source.current?.close();
    source.current = null;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const clear = useCallback(() => {
    disconnect();
    live.current = null;
    setSnapshot(null);
    setReconnecting(false);
  }, [disconnect]);

  const follow = useCallback(
    (initial: Snapshot) => {
      // A command response may arrive behind deltas already buffered by SSE.
      if (
        live.current?.run_id === initial.run_id &&
        initial.seq < live.current.seq
      )
        return;
      disconnect();
      live.current = { ...initial, steps: initial.steps ?? [] };
      if (initial.error)
        console.error("Run failed", initial.run_id, initial.error);
      setSnapshot(live.current);
      setReconnecting(false);
      if (!isActiveStatus(initial.status)) return;

      const token = generation.current;
      let resyncing = false;
      let checkAuth = false;
      let stream: EventSource;
      const isCurrent = () => token === generation.current;
      const flush = () => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
        if (isCurrent()) setSnapshot(live.current);
      };
      const publish = () => {
        if (!timer.current) timer.current = setTimeout(flush, 50);
      };
      const complete = () => {
        flush();
        stream.close();
        source.current = null;
        setReconnecting(false);
        if (live.current?.error)
          console.error("Run failed", live.current.run_id, live.current.error);
        if (live.current) terminalCallback.current(live.current);
      };
      const expire = () => {
        disconnect();
        live.current = null;
        setSnapshot(null);
        setReconnecting(false);
        expiredCallback.current();
      };

      async function resync() {
        if (resyncing || !isCurrent()) return;
        resyncing = true;
        stream.close();
        setReconnecting(true);
        try {
          const latest = await api.run(initial.run_id);
          if (!isCurrent()) return;
          live.current = { ...latest, steps: latest.steps ?? [] };
          flush();
          if (!isActiveStatus(latest.status)) {
            complete();
            return;
          }
        } catch (reason) {
          if (!isCurrent()) return;
          if (
            reason &&
            typeof reason === "object" &&
            "status" in reason &&
            reason.status === 401
          ) {
            expire();
            return;
          }
        } finally {
          resyncing = false;
        }
        if (isCurrent()) connect();
      }

      function handle(event: MessageEvent<string>) {
        if (!isCurrent() || resyncing) return;
        const parsed = parseRunEvent(event);
        if (!parsed || parsed.value.run_id !== initial.run_id) return;
        const current = live.current;
        if (parsed.kind === "snapshot") {
          const next = parsed.value;
          if (
            next.session_id !== initial.session_id ||
            (current && next.seq < current.seq)
          )
            return;
          live.current = { ...next, steps: next.steps ?? [] };
          setReconnecting(false);
          flush();
        } else {
          if (!current || parsed.value.seq <= current.seq) return;
          if (parsed.value.seq !== current.seq + 1) {
            void resync();
            return;
          }
          live.current = reduceRunDelta(current, parsed);
          publish();
        }
        if (live.current && !isActiveStatus(live.current.status)) complete();
      }

      function connect() {
        stream = new EventSource(api.eventsUrl(initial.run_id), {
          withCredentials: true,
        });
        source.current = stream;
        for (const name of [
          "snapshot",
          "text_delta",
          "reasoning_delta",
          "step",
          "status",
          "output_reset",
          "output_commit",
          "progress",
          "usage",
          "waiting",
          "artifacts",
        ])
          stream.addEventListener(name, handle as EventListener);
        stream.onopen = () => {
          if (isCurrent()) setReconnecting(false);
        };
        // Normal network failures use EventSource retry. Authentication expiry ends it.
        stream.onerror = async () => {
          if (!isCurrent()) return;
          setReconnecting(true);
          if (checkAuth) return;
          checkAuth = true;
          try {
            await api.me();
          } catch (reason) {
            if (
              isCurrent() &&
              reason &&
              typeof reason === "object" &&
              "status" in reason &&
              reason.status === 401
            )
              expire();
          } finally {
            checkAuth = false;
          }
        };
      }
      connect();
    },
    [disconnect],
  );

  useEffect(() => disconnect, [disconnect]);
  return { snapshot, reconnecting, follow, clear };
}
