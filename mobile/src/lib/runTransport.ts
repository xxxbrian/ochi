import { api } from "./api";
import { connectRunStream } from "./sse";
import type { StreamHandlers } from "../../../shared/conversation/runStream";

export const conversationTransport = {
  ...api,
  connect: (runId: string, handlers: StreamHandlers) => connectRunStream(api.eventsUrl(runId), handlers),
};
