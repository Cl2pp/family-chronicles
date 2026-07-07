'use client';

import { createContext, useContext, useMemo } from 'react';
import { DEFAULT_LOCALE, LOCALE_COOKIE, type Locale } from './config';
import { getDictionary, type Dictionary } from './index';

interface I18nValue {
  locale: Locale;
  t: Dictionary;
}

const I18nContext = createContext<I18nValue>({
  locale: DEFAULT_LOCALE,
  t: getDictionary(DEFAULT_LOCALE),
});

/**
 * Client-side dictionary provider. Receives only the locale from the server
 * (dictionaries contain functions, which cannot cross the RSC boundary) and
 * looks the dictionary up from the client bundle.
 */
export function I18nProvider({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  const value = useMemo(() => ({ locale, t: getDictionary(locale) }), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** `const { locale, t } = useI18n()` in client components. */
export function useI18n(): I18nValue {
  return useContext(I18nContext);
}

/** Persist the UI language; callers should router.refresh() so server components re-render. */
export function setLocaleCookie(locale: Locale) {
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; samesite=lax`;
}
