import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { errorForDisplay } from "../lib/errors";
import { api, getAPIBaseURL } from "../lib/api";
import { conversationTransport } from "../lib/runTransport";
import { useApp } from "../providers/AppProvider";
import { conversationKey, createConversationController, emptyConversation } from "../../../shared/conversation/controller";

export function useSessionChat(sessionId?: string, focused = true, draftId = "new") {
  const { user, invalidateLists } = useApp();
  const notify = useRef(invalidateLists);
  notify.current = invalidateLists;
  const controller = useMemo(() => createConversationController(conversationTransport, {
    onSessionChanged: () => notify.current(),
    onExpired: () => { void api.me().catch(() => undefined); },
  }), []);
  const origin = getAPIBaseURL();
  const owner = useMemo(() => ({ origin, account: user?.id ?? "", sessionId, draftId }), [origin, user?.id, sessionId, draftId]);
  const key = conversationKey(owner);
  const raw = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  // Mask another account/session before React runs layout cleanup.
  const state = raw.ownerKey === key || raw.adoptedFrom === key ? raw : emptyConversation(owner);
  useLayoutEffect(() => { controller.select(owner); }, [controller, owner]);
  useEffect(() => {
    const update = () => controller.setEnabled(focused && Boolean(user) && AppState.currentState === "active");
    update();
    const subscription = AppState.addEventListener("change", update);
    return () => { subscription.remove(); controller.setEnabled(false); };
  }, [controller, focused, user]);
  const receipts = state.instructions;
  return {
    ...state,
    error: state.error ? errorForDisplay(state.error, "error.load") : "",
    loadOlder: controller.loadOlder,
    refresh: controller.refreshAll,
    createAndSend: controller.createAndSend,
    send: controller.send,
    stop: controller.stop,
    resume: controller.resume,
    updateSession: controller.updateSession,
    cancelQueued: controller.cancelQueued,
    updateQueued: controller.updateQueued,
    instructions: {
      ...receipts, retryPending: receipts.retry, canSend: focused && controller.canSupplement(),
      send: controller.supplement, retry: controller.retrySupplement, refresh: controller.refreshInstructions,
    },
  };
}
