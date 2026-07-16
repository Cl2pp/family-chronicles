import { cookies } from 'next/headers';
import { DEFAULT_LOCALE, isLocale, LOCALE_COOKIE, type Locale } from './config';
import { getDictionary, type Dictionary } from './index';

/**
 * Resolve the UI locale: the `locale` cookie if set, otherwise the default
 * (German). German is the product default — this is a private German family
 * app — so we intentionally do NOT auto-negotiate from Accept-Language; users
 * who want another language switch it via the language picker (which sets the
 * cookie).
 */
export async function getLocale(): Promise<Locale> {
  const cookieValue = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (isLocale(cookieValue)) return cookieValue;
  return DEFAULT_LOCALE;
}

/** Locale + dictionary for server components: `const { locale, t } = await getI18n()`. */
export async function getI18n(): Promise<{ locale: Locale; t: Dictionary }> {
  const locale = await getLocale();
  return { locale, t: getDictionary(locale) };
}
