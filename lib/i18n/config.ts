/** Supported UI locales. The dictionary shape is defined by `en` (see en.ts). */
export const LOCALES = ['en', 'de'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'de';

/** Cookie that pins the UI language; absent → negotiate from Accept-Language. */
export const LOCALE_COOKIE = 'locale';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** Native-language names, used for the language pickers (never translated). */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  de: 'Deutsch',
};

/** Full BCP 47 tags for Intl date/number formatting. */
export const LOCALE_BCP47: Record<Locale, string> = {
  en: 'en-GB',
  de: 'de-DE',
};
