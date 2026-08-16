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

/**
 * The country as a *destination* — "to Austria", "in die Schweiz". Separate from
 * `countryLabel` because German needs a different preposition per country ("nach
 * Österreich" but "in die Schweiz"), so the whole phrase has to come from the dictionary
 * rather than being glued together from a bare country name.
 */
export function countryDestination(to: Dictionary['books']['order'], code: string): string {
  switch (code) {
    case 'DE':
      return to.countryToDE;
    case 'AT':
      return to.countryToAT;
    case 'CH':
      return to.countryToCH;
    default:
      return code;
  }
}

/**
 * The most inner pages a Gelato photo book can hold. Client-side mirror of `MAX_PAGES`
 * in `@/lib/gelato` — that module is server-only, so this duplicates the number rather
 * than importing its runtime. Keep the two in sync. A book above this can't be printed
 * at all, so the order screen says so instead of offering a form the printer would
 * reject.
 */
export const MAX_GELATO_PAGES = 200;

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
