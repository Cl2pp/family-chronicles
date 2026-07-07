'use client';

import { useState, useTransition } from 'react';
import { Alert, Button, Card, Group, TextInput, Textarea } from '@mantine/core';
import { IconPencil } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n/client';
import { updateStoryDetails } from './actions';

/** Inline edit form for a story's title, summary, retold text and year. */
export function EditControl({
  storyId,
  initial,
}: {
  storyId: string;
  initial: { title: string; summary: string; body: string; eventYear: number | null };
}) {
  const router = useRouter();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(initial.title);
  const [summary, setSummary] = useState(initial.summary);
  const [body, setBody] = useState(initial.body);
  const [year, setYear] = useState(initial.eventYear ? String(initial.eventYear) : '');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

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
      const res = await updateStoryDetails({
        storyId,
        title,
        summary,
        body,
        eventYear: year ? Number(year) : null,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setOpen(false);
      router.refresh();
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
      <TextInput
        label={t.story.editYearLabel}
        value={year}
        onChange={(e) => setYear(e.currentTarget.value.replace(/[^0-9]/g, ''))}
        w={140}
        mb="md"
      />
      <Group gap="xs">
        <Button size="xs" onClick={save} loading={pending} disabled={!body.trim() || !title.trim()}>
          {t.common.saveChanges}
        </Button>
        <Button size="xs" variant="default" onClick={() => setOpen(false)} disabled={pending}>
          {t.common.cancel}
        </Button>
      </Group>
    </Card>
  );
}
