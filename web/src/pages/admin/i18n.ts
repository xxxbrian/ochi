import { createTranslator } from "../../../../shared/i18n";
import { useI18n } from "../../lib/i18n";
import messages from "./messages.json";

export type AdminMessageKey = keyof typeof messages;
export const t = createTranslator(messages);
export { getLocale, formatDate, formatNumber } from "../../../../shared/i18n";
export { translateError } from "../../../../shared/i18n/errors";

export function useAdminI18n() {
  return useI18n();
}
