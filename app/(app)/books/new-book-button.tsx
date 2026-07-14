'use client';

import { useTransition } from 'react';
import { Button } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { createBookAction } from './actions';

/** "New book" — creates a draft from every ready story and jumps into the builder. */
export function NewBookButton({ label }: { label: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      leftSection={<IconPlus size={16} />}
      loading={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await createBookAction();
          // On success the action redirects; only errors return.
          if (result?.error) notifications.show({ message: result.error, color: 'red' });
        })
      }
    >
      {label}
    </Button>
  );
}
