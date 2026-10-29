import messages from "../../server/internal/i18n/messages.json";
import { formatMessage, type MessageParams } from "./index";

export type ErrorCode = keyof typeof messages;

// The Go HTTP boundary and both clients use the same public error catalog.
// Raw provider diagnostics and model/tool content are never translation keys.
export function translateError(code: string | undefined, params?: MessageParams): string | undefined {
  if (!code || !Object.prototype.hasOwnProperty.call(messages, code)) return undefined;
  return formatMessage(messages[code as ErrorCode], params);
}
