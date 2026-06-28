'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Group, Select } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { linkStoryAction } from '../actions';

export function LinkTelling({
  chronicleId,
  storyId,
  options,
}: {
  chronicleId: string;
  storyId: string;
  options: { value: string; label: string }[];
}) {
  const [value, setValue] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  if (options.length === 0) return null;

  function submit() {
    if (!value) return;
    startTransition(async () => {
      try {
        await linkStoryAction({ chronicleId, storyId, otherStoryId: value });
        setValue(null);
        router.refresh();
        notifications.show({ color: 'teal', message: 'Linked as the same event' });
      } catch {
        notifications.show({ color: 'red', message: 'Could not link the stories' });
      }
    });
  }

  return (
    <Group align="flex-end" gap="sm">
      <Select
        label="Link another telling of this event"
        placeholder="Choose a story"
        data={options}
        value={value}
        onChange={setValue}
        searchable
        style={{ flex: 1 }}
      />
      <Button onClick={submit} loading={pending} disabled={!value}>
        Link
      </Button>
    </Group>
  );
}
