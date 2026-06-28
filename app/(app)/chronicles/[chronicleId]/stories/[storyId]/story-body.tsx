'use client';

import { useState } from 'react';
import { SegmentedControl, Stack, Text } from '@mantine/core';

export function StoryBody({
  styled,
  original,
}: {
  styled: string | null;
  original: string | null;
}) {
  const hasStyled = Boolean(styled);
  const [view, setView] = useState<'memoir' | 'original'>(hasStyled ? 'memoir' : 'original');
  const text = view === 'memoir' ? styled : original;

  return (
    <Stack>
      {hasStyled && original ? (
        <SegmentedControl
          value={view}
          onChange={(v) => setView(v as 'memoir' | 'original')}
          data={[
            { value: 'memoir', label: 'Memoir' },
            { value: 'original', label: 'Original' },
          ]}
          w="fit-content"
        />
      ) : null}
      <Text
        style={{ whiteSpace: 'pre-wrap', lineHeight: 1.7 }}
        ff={view === 'memoir' ? 'Georgia, serif' : undefined}
        fz={view === 'memoir' ? 'lg' : 'md'}
      >
        {text}
      </Text>
    </Stack>
  );
}
