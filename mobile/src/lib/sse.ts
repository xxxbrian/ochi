import { fetch } from 'expo/fetch';
import { authHeaders } from './api';
import type { RunEvent } from '../../../web/src/lib/sse';
export type { RunEvent };

export { parseRunFrame } from './runEvents';
import { parseRunFrame } from './runEvents';

export function connectRunStream(url: string, handlers: {
  onOpen: () => void;
  onEvent: (event: RunEvent) => void;
  onClose: (reason?: Error & { status?: number }) => void;
}) {
  const controller = new AbortController();
  void (async () => {
    try {
      const response = await fetch(url, {
        headers: { ...authHeaders(), Accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = new Error(`Stream HTTP ${response.status}`) as Error & { status?: number };
        error.status = response.status;
        throw error;
      }
      if (!response.body) throw new Error('Stream unavailable');
      if (controller.signal.aborted) return;
      handlers.onOpen();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');
          let boundary: number;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const event = parseRunFrame(buffer.slice(0, boundary));
            buffer = buffer.slice(boundary + 2);
            if (event && !controller.signal.aborted) handlers.onEvent(event);
          }
        }
      } finally { reader.releaseLock(); }
      if (!controller.signal.aborted) handlers.onClose();
    } catch (reason) {
      if (!controller.signal.aborted) handlers.onClose(reason instanceof Error ? reason : new Error('Stream disconnected'));
    }
  })();
  return () => controller.abort();
}
