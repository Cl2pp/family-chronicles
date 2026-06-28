'use client';

import { useTransition } from 'react';
import { Button } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { retryStylingAction } from '../actions';

export function RetryButton({
  chronicleId,
  storyId,
}: {
  chronicleId: string;
  storyId: string;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <Button
      size="xs"
      variant="white"
      color="red"
      loading={pending}
      onClick={() =>
        startTransition(async () => {
          try {
            await retryStylingAction({ chronicleId, storyId });
          } catch {
            notifications.show({ color: 'red', message: 'Retry failed' });
          }
        })
      }
    >
      Try again
    </Button>
  );
}
