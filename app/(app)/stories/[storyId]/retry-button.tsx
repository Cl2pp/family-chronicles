'use client';

import { useTransition } from 'react';
import { Button } from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import { retryStory } from './actions';

export function RetryButton({ storyId }: { storyId: string }) {
  const [pending, startTransition] = useTransition();

  return (
    <Button
      color="red"
      variant="light"
      loading={pending}
      leftSection={<IconRefresh size={16} />}
      onClick={() => startTransition(() => retryStory(storyId))}
    >
      Retry
    </Button>
  );
}
