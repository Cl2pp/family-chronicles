import type { DatePrecision } from '@/lib/stories';
import { LOCALE_BCP47, type Locale } from '@/lib/i18n/config';
import { getDictionary } from '@/lib/i18n';

/** A Jan-1 UTC date from a 4-digit year (precision 'year'); null for missing years. */
export function yearToDate(year: number | null | undefined): Date | null {
  if (!year || Number.isNaN(year)) return null;
  return new Date(Date.UTC(year, 0, 1));
}

/** Coerce loose form input to a valid 4-digit year, or undefined. */
export function parseYear(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 9999) return undefined;
  return n;
}

/** The user-facing pieces of a fuzzy event date; null = not given. */
export interface EventDateParts {
  year: number | null;
  month: number | null;
  day: number | null;
}

/**
 * Combine loose day/month/year values into a stored fuzzy date. The year anchors
 * everything: without it there is no date. A valid month refines it to 'month'
 * precision, a valid calendar day to 'day'; out-of-range pieces are dropped rather
 * than rejected, so "day without month" still saves the year.
 */
export function partsToEventDate(parts: {
  year?: number | null;
  month?: number | null;
  day?: number | null;
}): { eventDate: Date | null; eventDatePrecision: 'day' | 'month' | 'year' | null } {
  const year = parseYear(parts.year);
  if (year === undefined) return { eventDate: null, eventDatePrecision: null };
  const month =
    parts.month != null && Number.isInteger(parts.month) && parts.month >= 1 && parts.month <= 12
      ? parts.month
      : null;
  if (!month) return { eventDate: new Date(Date.UTC(year, 0, 1)), eventDatePrecision: 'year' };
  const day =
    parts.day != null && Number.isInteger(parts.day) && parts.day >= 1 && parts.day <= 31
      ? parts.day
      : null;
  if (!day) {
    return { eventDate: new Date(Date.UTC(year, month - 1, 1)), eventDatePrecision: 'month' };
  }
  const d = new Date(Date.UTC(year, month - 1, day));
  // Date rolls impossible days (Feb 30) into the next month — fall back to month precision.
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return { eventDate: new Date(Date.UTC(year, month - 1, 1)), eventDatePrecision: 'month' };
  }
  return { eventDate: d, eventDatePrecision: 'day' };
}

/** Split a stored fuzzy date back into form segments; 'circa' exposes only its year. */
export function eventDateToParts(
  date: Date | string | null | undefined,
  precision: DatePrecision | null | undefined,
): EventDateParts {
  const none: EventDateParts = { year: null, month: null, day: null };
  if (!date || !precision) return none;
  const d = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return none;
  const year = d.getUTCFullYear();
  if (precision === 'year' || precision === 'circa') return { year, month: null, day: null };
  if (precision === 'month') return { year, month: d.getUTCMonth() + 1, day: null };
  return { year, month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Full localized calendar date, e.g. "12 March 1998" — for exact timestamps like createdAt. */
export function formatFullDate(date: Date | string, locale: Locale): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat(LOCALE_BCP47[locale], {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(d);
}

/** Human label for a fuzzy event date, e.g. "1998", "March 1998", "12 March 1998". */
export function formatEventDate(
  date: Date | string | null | undefined,
  precision: DatePrecision | null | undefined,
  locale: Locale,
): string | null {
  if (!date || !precision) return null;
  const d = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return null;

  const tag = LOCALE_BCP47[locale];
  switch (precision) {
    case 'year':
      return new Intl.DateTimeFormat(tag, { year: 'numeric', timeZone: 'UTC' }).format(d);
    case 'circa':
      return getDictionary(locale).dates.circa(
        new Intl.DateTimeFormat(tag, { year: 'numeric', timeZone: 'UTC' }).format(d),
      );
    case 'month':
      return new Intl.DateTimeFormat(tag, {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(d);
    case 'day':
      return new Intl.DateTimeFormat(tag, {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(d);
    default:
      return null;
  }
}
