import { describe, expect, it } from 'vitest';
import { parsePartialDate, partsToEventDate } from './dates';

describe('parsePartialDate', () => {
  it('parses a bare year', () => {
    expect(parsePartialDate('1994')).toEqual({ year: 1994, month: null, day: null });
  });

  it('parses year-month', () => {
    expect(parsePartialDate('1994-03')).toEqual({ year: 1994, month: 3, day: null });
  });

  it('parses a full date', () => {
    expect(parsePartialDate('1994-03-15')).toEqual({ year: 1994, month: 3, day: 15 });
  });

  it('tolerates surrounding whitespace and single-digit segments', () => {
    expect(parsePartialDate(' 800-1-2 ')).toEqual({ year: 800, month: 1, day: 2 });
  });

  it('rejects non-date strings', () => {
    expect(parsePartialDate('March 1994')).toBeNull();
    expect(parsePartialDate('15.03.1994')).toBeNull();
    expect(parsePartialDate('')).toBeNull();
  });
});

describe('partsToEventDate (via parsePartialDate)', () => {
  it('maps each format to its precision', () => {
    expect(partsToEventDate(parsePartialDate('1994')!)).toEqual({
      eventDate: new Date(Date.UTC(1994, 0, 1)),
      eventDatePrecision: 'year',
    });
    expect(partsToEventDate(parsePartialDate('1994-03')!)).toEqual({
      eventDate: new Date(Date.UTC(1994, 2, 1)),
      eventDatePrecision: 'month',
    });
    expect(partsToEventDate(parsePartialDate('1994-03-15')!)).toEqual({
      eventDate: new Date(Date.UTC(1994, 2, 15)),
      eventDatePrecision: 'day',
    });
  });
});
