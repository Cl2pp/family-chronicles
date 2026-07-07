'use client';

import { useState, useTransition } from 'react';
import { Button, Group, Select } from '@mantine/core';
import { IconShare } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n/client';
import { shareStory } from './actions';

/** Lets a contributor share this story into another of their chronicles. */
export function ShareControl({
  storyId,
  candidates,
}: {
  storyId: string;
  candidates: { id: string; name: string }[];
}) {
  const router = useRouter();
  const { t } = useI18n();
  const [value, setValue] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (candidates.length === 0) return null;

  function share() {
    if (!value) return;
    startTransition(async () => {
      await shareStory(storyId, value);
      setValue(null);
      router.refresh();
    });
  }

  return (
    <Group gap="xs" align="flex-end">
      <Select
        size="xs"
        placeholder={t.story.sharePlaceholder}
        data={candidates.map((c) => ({ value: c.id, label: c.name }))}
        value={value}
        onChange={setValue}
        w={220}
        disabled={pending}
      />
      <Button
        size="xs"
        variant="light"
        leftSection={<IconShare size={14} />}
        onClick={share}
        loading={pending}
        disabled={!value}
      >
        {t.common.share}
      </Button>
    </Group>
  );
}
