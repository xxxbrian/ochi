import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { createRunStream } from "../../../shared/conversation/runStream";
import { conversationTransport } from "../lib/runTransport";
import type { Snapshot } from "../lib/types";
export { reduceRunDelta as applyRunEvent } from "../../../shared/conversation/events";

export function useRunStream(onTerminal: (snapshot: Snapshot) => void, onExpired: () => void, enabled = true) {
  const callback = useRef({ onTerminal, onExpired });
  callback.current = { onTerminal, onExpired };
  const store = useMemo(() => createRunStream(conversationTransport, {
    onTerminal: (snapshot) => callback.current.onTerminal(snapshot),
    onExpired: () => callback.current.onExpired(),
  }), []);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => {
    const update = () => store.setEnabled(enabled && AppState.currentState === "active");
    update();
    const subscription = AppState.addEventListener("change", update);
    return () => { subscription.remove(); store.setEnabled(false); };
  }, [store, enabled]);
  return { ...state, follow: store.follow, clear: store.clear };
}
