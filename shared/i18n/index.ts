export const locales = ["en", "zh-CN", "zh-TW"] as const;
export type Locale = (typeof locales)[number];
export type LanguagePreference = Locale | "system";
export type MessageValue = string | { one: string; other: string };
export type Message = Record<Locale, MessageValue>;
export type Messages = Record<string, Message>;
export type MessageParams = Readonly<Record<string, string | number>>;

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === "system" || locales.includes(value as Locale);
}

export function normalizeLocale(value: string): Locale | undefined {
  const tag = value.trim().replace(/_/g, "-").toLowerCase();
  if (tag === "en" || tag.startsWith("en-")) return "en";
  if (tag !== "zh" && !tag.startsWith("zh-")) return undefined;
  const parts = tag.split("-");
  if (parts.includes("hant")) return "zh-TW";
  if (parts.includes("hans")) return "zh-CN";
  return parts.some((part) => ["tw", "hk", "mo"].includes(part)) ? "zh-TW" : "zh-CN";
}

export function resolveLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const locale = normalizeLocale(language);
    if (locale) return locale;
  }
  return "en";
}

function initialLanguages(): readonly string[] {
  if (typeof navigator !== "undefined" && navigator.languages?.length) return navigator.languages;
  return [Intl.DateTimeFormat().resolvedOptions().locale];
}

let preference: LanguagePreference = "system";
let systemLanguages = initialLanguages();
let locale = resolveLocale(systemLanguages);
let revision = 0;
const listeners = new Set<() => void>();

export function getLocale(): Locale { return locale; }
export function getLanguage(): LanguagePreference { return preference; }
export function getLocaleRevision(): number { return revision; }
export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function updateLocale(nextPreference: LanguagePreference): void {
  const nextLocale = nextPreference === "system" ? resolveLocale(systemLanguages) : nextPreference;
  if (preference === nextPreference && locale === nextLocale) return;
  preference = nextPreference;
  locale = nextLocale;
  revision += 1;
  for (const listener of listeners) listener();
}

export function setLanguage(value: LanguagePreference): void {
  if (!isLanguagePreference(value)) throw new RangeError("Unsupported language preference");
  updateLocale(value);
}

export function setSystemLanguages(languages: readonly string[]): void {
  systemLanguages = [...languages];
  updateLocale(preference);
}

export function formatMessage(message: Message, params: MessageParams = {}, language = getLocale()): string {
  const value = message[language];
  const text = typeof value === "string" ? value :
    value[new Intl.PluralRules(language).select(Number(params.count ?? 0)) === "one" ? "one" : "other"];
  return text.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (placeholder, name: string) => {
    const value = params[name];
    if (value === undefined) return placeholder;
    return typeof value === "number" ? formatNumber(value, undefined, language) : value;
  });
}

export function createTranslator<const C extends Messages>(messages: C) {
  return (key: keyof C & string, params?: MessageParams): string => {
    const message = messages[key];
    if (!message) throw new RangeError(`Unknown translation key: ${key}`);
    return formatMessage(message, params);
  };
}

export function formatDate(
  value: Date | string | number,
  options?: Intl.DateTimeFormatOptions,
  language = getLocale(),
): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "\u2014" : new Intl.DateTimeFormat(language, options).format(date);
}

export function formatNumber(
  value: number,
  options?: Intl.NumberFormatOptions,
  language = getLocale(),
): string {
  return new Intl.NumberFormat(language, options).format(value);
}

export function formatRelativeTime(
  value: number,
  unit: Intl.RelativeTimeFormatUnit,
  options: Intl.RelativeTimeFormatOptions = { numeric: "auto" },
): string {
  return new Intl.RelativeTimeFormat(getLocale(), options).format(value, unit);
}
