import type { Dictionary } from '@/lib/i18n';

/**
 * Client-side mirror of `BOOK_SHIPPING_COUNTRIES` in `@/lib/book-orders`. That module is
 * server-only (it talks to the database and the Gelato API), so a 'use client' file can
 * only import TYPES from it — this is the one value we need on the client (the country
 * `Select`'s options), duplicated here deliberately. Keep the two lists in sync; the
 * server validates the submitted country anyway, so a drift here can only ever offer a
 * country the server then rejects, never smuggle one through.
 */
export const ORDER_COUNTRY_CODES = ['DE', 'AT', 'CH'] as const;

export type OrderCountryCode = (typeof ORDER_COUNTRY_CODES)[number];

/** Localized country name for a two-letter code. Unknown codes (an order placed before
 *  the list changed) fall back to the raw code rather than rendering blank. */
export function countryLabel(to: Dictionary['books']['order'], code: string): string {
  switch (code) {
    case 'DE':
      return to.countryDE;
    case 'AT':
      return to.countryAT;
    case 'CH':
      return to.countryCH;
    default:
      return code;
  }
}
