import { api } from "./api";
import { parseRunEvent, runEventNames } from "../../../shared/conversation/events";
import type { StreamHandlers } from "../../../shared/conversation/runStream";

export const conversationTransport = {
  ...api,
  connect(runId: string, handlers: StreamHandlers) {
    const source = new EventSource(api.eventsUrl(runId), { withCredentials: true });
    const receive = (event: Event) => {
      const parsed = parseRunEvent(event as MessageEvent<string>);
      if (parsed) handlers.onEvent(parsed);
    };
    for (const name of runEventNames) source.addEventListener(name, receive);
    source.onopen = handlers.onOpen;
    source.onerror = () => { source.close(); handlers.onClose(); };
    return () => source.close();
  },
};
