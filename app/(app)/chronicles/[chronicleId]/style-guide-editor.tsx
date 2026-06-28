'use client';

import { useState, useTransition } from 'react';
import { Button, Group, Stack, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { updateStyleGuideAction } from './actions';

export function StyleGuideEditor({
  chronicleId,
  initialValue,
}: {
  chronicleId: string;
  initialValue: string;
}) {
  const [value, setValue] = useState(initialValue);
  const [pending, startTransition] = useTransition();

  function save() {
    startTransition(async () => {
      try {
        await updateStyleGuideAction({ chronicleId, styleGuide: value });
        notifications.show({ color: 'teal', message: 'Style guide saved' });
      } catch {
        notifications.show({ color: 'red', message: 'Could not save style guide' });
      }
    });
  }

  return (
    <Stack>
      <Textarea
        label="Style guide"
        description="How should the family's stories read? Tone, voice, perspective, formatting — the AI follows this when rewriting every story."
        placeholder="e.g. Warm and reflective, like a grandparent recalling the past. Keep place names in their original spelling. Refer to family members by first name."
        autosize
        minRows={5}
        value={value}
        onChange={(e) => setValue(e.currentTarget.value)}
      />
      <Group justify="flex-end">
        <Button onClick={save} loading={pending} disabled={value === initialValue}>
          Save
        </Button>
      </Group>
    </Stack>
  );
}
