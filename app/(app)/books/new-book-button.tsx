'use client';

import { useState, useTransition } from 'react';
import { Button, Card, Group, Modal, Stack, Text } from '@mantine/core';
import { IconBook2, IconPhoto, IconPlus } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { useI18n } from '@/lib/i18n/client';
import { createBookAction, createPhotoBookAction } from './actions';

/**
 * "New book" — asks Story book vs Photo book (docs/PHOTO_BOOK_PLAN.md §1), then
 * creates a draft and jumps into its builder. A story book starts from every ready
 * story; a photo book starts empty and is filled by the bulk uploader.
 */
export function NewBookButton({ label }: { label: string }) {
  const { t } = useI18n();
  const [opened, setOpened] = useState(false);
  const [pending, startTransition] = useTransition();

  function createStoryBook() {
    startTransition(async () => {
      const result = await createBookAction();
      // On success the action redirects; only errors return.
      if (result?.error) notifications.show({ message: result.error, color: 'red' });
    });
  }

  function createPhotoBook() {
    startTransition(async () => {
      const result = await createPhotoBookAction();
      if (result?.error) notifications.show({ message: result.error, color: 'red' });
    });
  }

  return (
    <>
      <Button leftSection={<IconPlus size={16} />} onClick={() => setOpened(true)}>
        {label}
      </Button>
      <Modal opened={opened} onClose={() => setOpened(false)} title={label} centered>
        <Stack gap="sm">
          <Card
            withBorder
            radius="md"
            p="md"
            component="button"
            type="button"
            disabled={pending}
            style={{ cursor: 'pointer', textAlign: 'left', width: '100%' }}
            onClick={createStoryBook}
          >
            <Group gap="sm" wrap="nowrap">
              <IconBook2 size={24} stroke={1.6} color="var(--mantine-color-brand-6)" />
              <Stack gap={2}>
                <Text fw={600}>{t.books.kindStory}</Text>
                <Text fz={13} c="dimmed">
                  {t.books.kindStoryHint}
                </Text>
              </Stack>
            </Group>
          </Card>
          <Card
            withBorder
            radius="md"
            p="md"
            component="button"
            type="button"
            disabled={pending}
            style={{ cursor: 'pointer', textAlign: 'left', width: '100%' }}
            onClick={createPhotoBook}
          >
            <Group gap="sm" wrap="nowrap">
              <IconPhoto size={24} stroke={1.6} color="var(--mantine-color-brand-6)" />
              <Stack gap={2}>
                <Text fw={600}>{t.books.kindPhoto}</Text>
                <Text fz={13} c="dimmed">
                  {t.books.kindPhotoHint}
                </Text>
              </Stack>
            </Group>
          </Card>
        </Stack>
      </Modal>
    </>
  );
}
