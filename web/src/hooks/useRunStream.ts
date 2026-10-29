import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { createRunStream } from "../../../shared/conversation/runStream";
import { conversationTransport } from "../lib/runTransport";
import type { Snapshot } from "../lib/types";

export function useRunStream(onTerminal: (snapshot: Snapshot) => void, onExpired: () => void) {
  const callback = useRef({ onTerminal, onExpired });
  callback.current = { onTerminal, onExpired };
  const store = useMemo(() => createRunStream(conversationTransport, {
    onTerminal: (snapshot) => callback.current.onTerminal(snapshot),
    onExpired: () => callback.current.onExpired(),
  }), []);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => {
    const update = () => store.setEnabled(document.visibilityState !== "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    return () => { document.removeEventListener("visibilitychange", update); store.setEnabled(false); };
  }, [store]);
  return { ...state, follow: store.follow, clear: store.clear };
}
