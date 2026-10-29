import { translateError } from '../../../shared/i18n/errors';
import { t, type MessageKey } from './i18n';
import type { MessageParams } from '../../../shared/i18n';

type ErrorSource = { key: MessageKey; params?: MessageParams } | { code: string; params?: MessageParams; fallback: MessageKey };

export class LocalizedError extends Error {
  readonly source: ErrorSource;

  constructor(source: ErrorSource) {
    super();
    this.name = 'LocalizedError';
    this.source = source;
    // Resolve when rendered, so an existing notice follows a language change.
    Object.defineProperty(this, 'message', { configurable: true, get: () =>
      'key' in source ? t(source.key, source.params) : translateError(source.code, source.params) ?? t(source.fallback),
    });
  }
}

export type DisplayError = string | LocalizedError;

export function localizedError(key: MessageKey, params?: MessageParams) {
  return new LocalizedError({ key, params });
}

export function errorForDisplay(reason: unknown, fallback: MessageKey) {
  if (reason instanceof LocalizedError) return reason;
  if (reason && typeof reason === 'object' && 'code' in reason && typeof reason.code === 'string') {
    const params = 'params' in reason && reason.params && typeof reason.params === 'object'
      ? reason.params as MessageParams : undefined;
    if (translateError(reason.code, params)) return new LocalizedError({ code: reason.code, params, fallback });
  }
  return localizedError(fallback);
}

export function errorText(error: DisplayError | null | undefined) {
  return typeof error === 'string' ? error : error?.message ?? '';
}
