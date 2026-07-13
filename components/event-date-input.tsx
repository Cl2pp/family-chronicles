'use client';

import { useRef } from 'react';
import { Input } from '@mantine/core';
import { useI18n } from '@/lib/i18n/client';

/** Raw form segments — digits only, empty string = not given. */
export interface EventDateValue {
  day: string;
  month: string;
  year: string;
}

export function eventDateValueFromParts(parts: {
  year: number | null;
  month: number | null;
  day: number | null;
}): EventDateValue {
  return {
    day: parts.day ? String(parts.day).padStart(2, '0') : '',
    month: parts.month ? String(parts.month).padStart(2, '0') : '',
    year: parts.year ? String(parts.year) : '',
  };
}

export function eventDateValueToParts(value: EventDateValue): {
  year: number | null;
  month: number | null;
  day: number | null;
} {
  return {
    year: value.year ? Number(value.year) : null,
    month: value.month ? Number(value.month) : null,
    day: value.day ? Number(value.day) : null,
  };
}

const segmentStyle: React.CSSProperties = {
  border: 'none',
  outline: 'none',
  background: 'transparent',
  font: 'inherit',
  color: 'inherit',
  padding: 0,
  textAlign: 'center',
};

/**
 * One visual input with day.month.year segments for a story's fuzzy event date.
 * Only the year makes it a date; day and month are optional refinements (they map
 * to `eventDatePrecision`). Typing auto-advances between segments; Backspace on an
 * empty segment jumps back.
 */
export function EventDateInput({
  value,
  onChange,
  mb,
}: {
  value: EventDateValue;
  onChange: (v: EventDateValue) => void;
  mb?: string | number;
}) {
  const { t } = useI18n();
  const dayRef = useRef<HTMLInputElement>(null);
  const monthRef = useRef<HTMLInputElement>(null);
  const yearRef = useRef<HTMLInputElement>(null);

  function setSegment(
    part: keyof EventDateValue,
    raw: string,
    max: number,
    next?: React.RefObject<HTMLInputElement | null>,
  ) {
    const digits = raw.replace(/[^0-9]/g, '').slice(0, max);
    onChange({ ...value, [part]: digits });
    if (digits.length === max && raw.length > value[part].length) next?.current?.focus();
  }

  function jumpBack(
    e: React.KeyboardEvent<HTMLInputElement>,
    part: keyof EventDateValue,
    prev: HTMLInputElement | null,
  ) {
    if (e.key === 'Backspace' && value[part] === '') {
      e.preventDefault();
      prev?.focus();
    }
  }

  return (
    <Input.Wrapper label={t.dates.eventDateLabel} description={t.dates.eventDateHint} mb={mb}>
      <Input
        component="div"
        w={190}
        styles={{ input: { display: 'flex', alignItems: 'center', gap: 2, cursor: 'text' } }}
      >
        <input
          ref={dayRef}
          value={value.day}
          onChange={(e) => setSegment('day', e.currentTarget.value, 2, monthRef)}
          placeholder={t.dates.dayPlaceholder}
          aria-label={t.dates.day}
          inputMode="numeric"
          style={{ ...segmentStyle, width: '2.6ch' }}
        />
        <span style={{ opacity: 0.5 }}>.</span>
        <input
          ref={monthRef}
          value={value.month}
          onChange={(e) => setSegment('month', e.currentTarget.value, 2, yearRef)}
          onKeyDown={(e) => jumpBack(e, 'month', dayRef.current)}
          placeholder={t.dates.monthPlaceholder}
          aria-label={t.dates.month}
          inputMode="numeric"
          style={{ ...segmentStyle, width: '2.6ch' }}
        />
        <span style={{ opacity: 0.5 }}>.</span>
        <input
          ref={yearRef}
          value={value.year}
          onChange={(e) => setSegment('year', e.currentTarget.value, 4)}
          onKeyDown={(e) => jumpBack(e, 'year', monthRef.current)}
          placeholder={t.dates.yearPlaceholder}
          aria-label={t.dates.year}
          inputMode="numeric"
          style={{ ...segmentStyle, width: '4.6ch' }}
        />
      </Input>
    </Input.Wrapper>
  );
}
