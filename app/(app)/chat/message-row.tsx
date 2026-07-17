'use client';

import { useState } from 'react';
import { Group, Paper, Stack, Text } from '@mantine/core';
import { useI18n } from '@/lib/i18n/client';
import { ActionReceipts } from './action-receipts';
import { MessageAttachments } from './message-attachments';
import { MessageMarkdown } from './message-markdown';
import { PeopleChangesCard } from './people-changes-card';
import { StoryDraftCard } from './story-draft-card';
import type { Msg, MsgResult } from './types';

export function MessageRow({
  msg,
  conversationId,
  onResult,
}: {
  msg: Msg;
  conversationId: string | null;
  onResult: (r: MsgResult) => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  // One message can carry BOTH a story card and a tree-changes card (a turn that
  // drafts a story and stages people edits) — each card resolves independently.
  const [storyDiscarded, setStoryDiscarded] = useState(false);
  const [peopleDiscarded, setPeopleDiscarded] = useState(false);

  // A story result settles the story card, a people result the people card — never
  // each other. `msg.result` only holds the most recent one; the other card stays live.
  const storySettled = (msg.result && msg.result.kind !== 'people') || storyDiscarded;
  const peopleSettled = msg.result?.kind === 'people' || peopleDiscarded;

  if (msg.role === 'user') {
    return (
      <Group justify="flex-end">
        <Stack gap={6} align="flex-end" maw="80%">
          {msg.content && (
            <Paper bg="brand.6" c="white" p="sm" radius="md">
              <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                {msg.content}
              </Text>
            </Paper>
          )}
          {msg.attachments?.length ? <MessageAttachments attachments={msg.attachments} /> : null}
        </Stack>
      </Group>
    );
  }

  return (
    <Stack gap="xs" align="flex-start" maw="80%">
      {msg.content && (
        <Paper bg="slate.1" p="sm" radius="md">
          <MessageMarkdown content={msg.content} />
        </Paper>
      )}

      {msg.receipts?.length ? <ActionReceipts receipts={msg.receipts} /> : null}

      {msg.result && msg.result.kind !== 'people' && (
        <ActionReceipts
          receipts={[
            {
              label:
                msg.result.kind === 'story-update'
                  ? t.chat.updatedStory(msg.result.title)
                  : t.chat.savedStoryTo(msg.result.title, msg.result.chronicleName),
              detail: t.chat.viewStory,
              href: `/stories/${msg.result.storyId}`,
            },
          ]}
        />
      )}

      {msg.result && msg.result.kind === 'people' && (
        <>
          {msg.result.receipts.length ? <ActionReceipts receipts={msg.result.receipts} /> : null}
          {msg.result.errors.length ? (
            <Text size="xs" c="dimmed">
              {t.chat.changesPartlyFailed(msg.result.errors.length)}
            </Text>
          ) : null}
        </>
      )}

      {msg.storyDraft && !storySettled && (
        <StoryDraftCard
          draft={msg.storyDraft}
          conversationId={conversationId}
          busy={busy}
          setBusy={setBusy}
          onDiscard={() => setStoryDiscarded(true)}
          onResult={onResult}
        />
      )}

      {msg.peopleDraft && !peopleSettled && (
        <PeopleChangesCard
          draft={msg.peopleDraft}
          conversationId={conversationId}
          busy={busy}
          setBusy={setBusy}
          onDiscard={() => setPeopleDiscarded(true)}
          onResult={onResult}
        />
      )}
    </Stack>
  );
}
