import type { DatePrecision } from '@/lib/stories';

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

/** Human label for a fuzzy event date, e.g. "1998", "March 1998", "12 March 1998". */
export function formatEventDate(
  date: Date | string | null | undefined,
  precision: DatePrecision | null | undefined,
): string | null {
  if (!date || !precision) return null;
  const d = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return null;

  switch (precision) {
    case 'year':
      return new Intl.DateTimeFormat('en', { year: 'numeric', timeZone: 'UTC' }).format(d);
    case 'circa':
      return `around ${new Intl.DateTimeFormat('en', {
        year: 'numeric',
        timeZone: 'UTC',
      }).format(d)}`;
    case 'month':
      return new Intl.DateTimeFormat('en', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(d);
    case 'day':
      return new Intl.DateTimeFormat('en', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(d);
    default:
      return null;
  }
}
