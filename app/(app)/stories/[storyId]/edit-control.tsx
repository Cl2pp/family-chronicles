'use client';

import { useState, useTransition } from 'react';
import { Alert, Button, Card, Divider, Group, Text, TextInput, Textarea } from '@mantine/core';
import { IconPencil, IconTrash } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n/client';
import type { EventDateParts } from '@/lib/dates';
import {
  EventDateInput,
  eventDateValueFromParts,
  eventDateValueToParts,
} from '@/components/event-date-input';
import { deleteStory, updateStoryDetails } from './actions';

/** Inline edit form for a story's title, summary, retold text and date. */
export function EditControl({
  storyId,
  initial,
}: {
  storyId: string;
  initial: { title: string; summary: string; body: string; eventDate: EventDateParts };
}) {
  const router = useRouter();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(initial.title);
  const [summary, setSummary] = useState(initial.summary);
  const [body, setBody] = useState(initial.body);
  const [date, setDate] = useState(eventDateValueFromParts(initial.eventDate));
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pending, startTransition] = useTransition();
  const [deleting, startDeleteTransition] = useTransition();

  if (!open) {
    return (
      <Group>
        <Button
          size="xs"
          variant="light"
          leftSection={<IconPencil size={14} />}
          onClick={() => setOpen(true)}
        >
          {t.story.editStory}
        </Button>
      </Group>
    );
  }

  function save() {
    setError(null);
    startTransition(async () => {
      const parts = eventDateValueToParts(date);
      const res = await updateStoryDetails({
        storyId,
        title,
        summary,
        body,
        eventYear: parts.year,
        eventMonth: parts.month,
        eventDay: parts.day,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  function remove() {
    setError(null);
    startDeleteTransition(async () => {
      const res = await deleteStory(storyId);
      if (!res.ok) {
        setError(res.error);
        setConfirmDelete(false);
        return;
      }
      router.push('/stories');
    });
  }

  return (
    <Card withBorder radius="md" p="md">
      {error && (
        <Alert color="red" variant="light" mb="sm">
          {error}
        </Alert>
      )}
      <TextInput
        label={t.story.editTitleLabel}
        value={title}
        onChange={(e) => setTitle(e.currentTarget.value)}
        mb="xs"
      />
      <TextInput
        label={t.story.editSummaryLabel}
        value={summary}
        onChange={(e) => setSummary(e.currentTarget.value)}
        mb="xs"
      />
      <Textarea
        label={t.story.editStoryLabel}
        description={t.story.editStoryDescription}
        value={body}
        onChange={(e) => setBody(e.currentTarget.value)}
        autosize
        minRows={6}
        maxRows={20}
        mb="xs"
      />
      <EventDateInput value={date} onChange={setDate} mb="md" />
      <Group gap="xs">
        <Button size="xs" onClick={save} loading={pending} disabled={!body.trim() || !title.trim()}>
          {t.common.saveChanges}
        </Button>
        <Button size="xs" variant="default" onClick={() => setOpen(false)} disabled={pending}>
          {t.common.cancel}
        </Button>
      </Group>

      <Divider my="md" />
      {confirmDelete ? (
        <Group gap="xs">
          <Text size="sm" c="red.8">
            {t.story.deleteConfirmText}
          </Text>
          <Button size="xs" color="red" onClick={remove} loading={deleting}>
            {t.story.deletePermanently}
          </Button>
          <Button
            size="xs"
            variant="default"
            onClick={() => setConfirmDelete(false)}
            disabled={deleting}
          >
            {t.story.keepStory}
          </Button>
        </Group>
      ) : (
        <Button
          size="xs"
          color="red"
          variant="subtle"
          leftSection={<IconTrash size={14} />}
          onClick={() => setConfirmDelete(true)}
          disabled={pending}
        >
          {t.story.deleteStory}
        </Button>
      )}
    </Card>
  );
}
