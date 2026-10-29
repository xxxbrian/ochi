import { useSyncExternalStore } from 'react';
import * as SecureStore from 'expo-secure-store';
import {
  createTranslator, getLanguage, getLocale, getLocaleRevision, isLanguagePreference,
  setLanguage, setSystemLanguages, subscribeLocale,
  type LanguagePreference,
} from '../../../shared/i18n';
import { messages } from './messages';

export {
  formatDate, formatNumber, formatRelativeTime, getLanguage, getLocale,
  getLocaleRevision, isLanguagePreference, normalizeLocale, setLanguage,
  setSystemLanguages, subscribeLocale,
} from '../../../shared/i18n';
export type { LanguagePreference, Locale } from '../../../shared/i18n';
export type MessageKey = keyof typeof messages;

const LANGUAGE_KEY = 'ochi.language.v1';
let languageWrite = Promise.resolve();
export const t = createTranslator(messages);

export function useI18n() {
  useSyncExternalStore(subscribeLocale, getLocaleRevision, getLocaleRevision);
  return { t, locale: getLocale(), language: getLanguage() };
}

export async function restoreLanguage(systemLanguages: string[]) {
  setSystemLanguages(systemLanguages);
  const saved = await SecureStore.getItemAsync(LANGUAGE_KEY).catch(() => null);
  if (isLanguagePreference(saved)) setLanguage(saved);
}

export async function rememberLanguage(language: LanguagePreference) {
  setLanguage(language);
  const write = languageWrite.catch(() => undefined).then(() => SecureStore.setItemAsync(LANGUAGE_KEY, language));
  languageWrite = write;
  await write;
}

export function weekdayNames(width: 'short' | 'long' | 'narrow' = 'short') {
  const formatter = new Intl.DateTimeFormat(getLocale(), { weekday: width, timeZone: 'UTC' });
  return Array.from({ length: 7 }, (_, index) => formatter.format(new Date(Date.UTC(2024, 0, index + 1))));
}

export function thinkingLevelLabel(value?: string) {
  switch (value) {
    case 'on': return t('model.on');
    case 'off': return t('model.off');
    case 'none': return t('model.none');
    case 'minimal': return t('model.minimal');
    case 'low': return t('model.low');
    case 'medium': return t('model.medium');
    case 'high': return t('model.high');
    case 'xhigh': return t('model.xhigh');
    case 'max': return t('model.max');
    case 'ultra': return t('model.ultra');
    default: return value || t('common.default');
  }
}
