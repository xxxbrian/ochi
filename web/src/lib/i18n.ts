import { useSyncExternalStore } from "react";
import {
  createTranslator,
  getLanguage,
  getLocale,
  getLocaleRevision,
  isLanguagePreference,
  locales,
  setLanguage,
  setSystemLanguages,
  subscribeLocale,
  type Locale,
} from "../../../shared/i18n";
import { messages } from "./messages";

export * from "../../../shared/i18n";
export const t = createTranslator(messages);

const languageKey = "ochi.language";

if (typeof window !== "undefined") {
  const nativeComputer = window.location.pathname === "/native/computer";
  const nativeLocale = (value: unknown): Locale | undefined =>
    typeof value === "string" ? locales.find((locale) => locale === value) : undefined;
  if (nativeComputer) {
    // The native shell owns this viewer's language; it is not a Web preference.
    const initial = nativeLocale(new URLSearchParams(window.location.search).get("locale"));
    if (initial) setLanguage(initial);
    window.addEventListener("ochi:native-locale", (event) => {
      const next = nativeLocale((event as CustomEvent<{ locale?: unknown }>).detail?.locale);
      if (next) setLanguage(next);
    });
  } else {
    try {
      const saved = window.localStorage.getItem(languageKey);
      if (isLanguagePreference(saved)) setLanguage(saved);
    } catch {
      // Language switching remains available when browser storage is disabled.
    }
  }
  const updateDocument = () => {
    document.documentElement.lang = getLocale();
    if (nativeComputer) return;
    try { window.localStorage.setItem(languageKey, getLanguage()); } catch { /* Optional storage. */ }
  };
  subscribeLocale(updateDocument);
  updateDocument();
  window.addEventListener("languagechange", () => setSystemLanguages(navigator.languages));
}

export function useI18n() {
  useSyncExternalStore(subscribeLocale, getLocaleRevision, getLocaleRevision);
  return { t, locale: getLocale(), language: getLanguage(), setLanguage };
}
