'use client';

import { useState } from 'react';
import { Button, Card, Group, Text, TextInput, Textarea } from '@mantine/core';
import { IconSparkles } from '@tabler/icons-react';
import type { StoryDraft } from '@/lib/ai/tools';
import { acceptStory, applyStoryUpdate, discardStoryDraft } from './actions';
import type { MsgResult } from './types';

/** Editable story draft (new or a revision) proposed by the assistant, with accept/discard. */
export function StoryDraftCard({
  draft,
  conversationId,
  busy,
  setBusy,
  onDiscard,
  onResult,
}: {
  draft: StoryDraft;
  conversationId: string | null;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onDiscard: () => void;
  onResult: (r: MsgResult) => void;
}) {
  const { proposal, chronicleId, chronicleName, updateStoryId } = draft;
  const isUpdate = Boolean(updateStoryId);
  const [title, setTitle] = useState(proposal.title);
  const [body, setBody] = useState(proposal.body);
  const [year, setYear] = useState(proposal.eventYear ? String(proposal.eventYear) : '');

  function discard() {
    onDiscard();
    // Best-effort: tell the conversation the card was discarded so the agent knows.
    if (conversationId) void discardStoryDraft({ conversationId, title });
  }

  async function accept() {
    setBusy(true);
    try {
      const edited = { ...proposal, title, body, eventYear: year ? Number(year) : null };
      if (updateStoryId) {
        const res = await applyStoryUpdate({ storyId: updateStoryId, proposal: edited, conversationId });
        onResult({ kind: 'story-update', storyId: res.storyId, chronicleName });
      } else {
        const res = await acceptStory({
          conversationId: conversationId ?? '',
          chronicleId,
          proposal: edited,
        });
        onResult({ kind: 'story', storyId: res.storyId, chronicleName });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card withBorder radius="md" p="md" maw={560} w="100%">
      <Group gap={6} mb="xs">
        <IconSparkles size={15} color="var(--mantine-color-brand-6)" />
        <Text size="xs" fw={600} c="brand.7" tt="uppercase">
          {isUpdate ? 'Story update' : 'Story draft'} · {chronicleName}
        </Text>
      </Group>
      <TextInput
        label="Title"
        value={title}
        onChange={(e) => setTitle(e.currentTarget.value)}
        mb="xs"
      />
      {proposal.summary && (
        <Text size="sm" c="dimmed" mb="xs">
          {proposal.summary}
        </Text>
      )}
      <Textarea
        label="Story"
        value={body}
        onChange={(e) => setBody(e.currentTarget.value)}
        autosize
        minRows={4}
        maxRows={14}
        mb="xs"
      />
      <TextInput
        label="Year (optional)"
        value={year}
        onChange={(e) => setYear(e.currentTarget.value.replace(/[^0-9]/g, ''))}
        w={140}
        mb="md"
      />
      <Group gap="xs">
        <Button size="xs" onClick={accept} loading={busy}>
          {isUpdate ? 'Save changes' : 'Accept & save'}
        </Button>
        <Button size="xs" variant="default" onClick={discard} disabled={busy}>
          Discard
        </Button>
      </Group>
    </Card>
  );
}
