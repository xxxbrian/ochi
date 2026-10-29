import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { API_BASE } from "../lib/api";
import { conversationTransport } from "../lib/runTransport";
import { conversationKey, createConversationController, emptyConversation } from "../../../shared/conversation/controller";
import type { Session } from "../lib/types";

export function useConversation(account: string, sessionId: string | undefined, draftId: string, callbacks: {
  onSessionChanged(session: Session): void;
  onExpired(): void;
}) {
  const callback = useRef(callbacks);
  callback.current = callbacks;
  const controller = useMemo(() => createConversationController(conversationTransport, {
    onSessionChanged: (session) => callback.current.onSessionChanged(session),
    onExpired: () => callback.current.onExpired(),
  }), []);
  const owner = useMemo(() => ({ origin: API_BASE || window.location.origin, account, sessionId, draftId }), [account, sessionId, draftId]);
  const key = conversationKey(owner);
  const raw = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const state = raw.ownerKey === key || raw.adoptedFrom === key ? raw : emptyConversation(owner);
  useLayoutEffect(() => { controller.select(owner); }, [controller, owner]);
  useEffect(() => {
    const update = () => controller.setEnabled(Boolean(account) && document.visibilityState !== "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    return () => { document.removeEventListener("visibilitychange", update); controller.setEnabled(false); };
  }, [controller, account]);
  return { ...state, controller, instructions: {
    ...state.instructions, retryPending: state.instructions.retry, canSend: controller.canSupplement(),
    send: controller.supplement, retry: controller.retrySupplement, refresh: controller.refreshInstructions,
  } };
}
