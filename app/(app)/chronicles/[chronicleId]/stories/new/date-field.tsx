'use client';

import { useState } from 'react';
import { SegmentedControl, Text } from '@mantine/core';
import { DateInput, MonthPickerInput, YearPickerInput } from '@mantine/dates';

export interface DatePayload {
  eventDate: string | null;
  eventDatePrecision: 'day' | 'month' | 'year' | null;
}

type Precision = 'unknown' | 'year' | 'month' | 'day';

export function DateField({ onChange }: { onChange: (p: DatePayload) => void }) {
  const [precision, setPrecision] = useState<Precision>('unknown');
  const [dateValue, setDateValue] = useState<string | null>(null);

  function emit(p: Precision, dv: string | null) {
    if (p === 'unknown' || !dv) {
      onChange({ eventDate: null, eventDatePrecision: null });
    } else {
      onChange({ eventDate: new Date(dv).toISOString(), eventDatePrecision: p });
    }
  }

  function changePrecision(p: Precision) {
    setPrecision(p);
    setDateValue(null);
    emit(p, null);
  }

  function changeDate(dv: string | null) {
    setDateValue(dv);
    emit(precision, dv);
  }

  return (
    <div>
      <Text size="sm" fw={500} mb={4}>
        When did it happen?
      </Text>
      <SegmentedControl
        value={precision}
        onChange={(v) => changePrecision(v as Precision)}
        data={[
          { value: 'unknown', label: 'Unknown' },
          { value: 'year', label: 'Year' },
          { value: 'month', label: 'Month' },
          { value: 'day', label: 'Exact day' },
        ]}
      />
      {precision === 'year' && (
        <YearPickerInput mt="sm" placeholder="Pick a year" value={dateValue} onChange={changeDate} />
      )}
      {precision === 'month' && (
        <MonthPickerInput
          mt="sm"
          placeholder="Pick a month"
          value={dateValue}
          onChange={changeDate}
        />
      )}
      {precision === 'day' && (
        <DateInput mt="sm" placeholder="Pick a date" value={dateValue} onChange={changeDate} />
      )}
    </div>
  );
}
