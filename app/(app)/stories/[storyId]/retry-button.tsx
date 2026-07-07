'use client';

import { useTransition } from 'react';
import { Button } from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import { useI18n } from '@/lib/i18n/client';
import { retryStory } from './actions';

export function RetryButton({ storyId }: { storyId: string }) {
  const { t } = useI18n();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      color="red"
      variant="light"
      loading={pending}
      leftSection={<IconRefresh size={16} />}
      onClick={() => startTransition(() => retryStory(storyId))}
    >
      {t.common.retry}
    </Button>
  );
}
