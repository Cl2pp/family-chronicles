'use client';

import { useState } from 'react';
import { Group, Paper, Stack, Text } from '@mantine/core';
import { useI18n } from '@/lib/i18n/client';
import { ActionReceipts } from './action-receipts';
import { MessageAttachments } from './message-attachments';
import { MessageMarkdown } from './message-markdown';
import { PeopleChangesCard } from './people-changes-card';
import { StoryDraftCard } from './story-draft-card';
import type { Msg, MsgPeopleResult, MsgResult } from './types';

export function MessageRow({
  msg,
  conversationId,
  onResult,
  onPeopleResult,
}: {
  msg: Msg;
  conversationId: string | null;
  onResult: (r: MsgResult) => void;
  onPeopleResult: (r: MsgPeopleResult) => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  // One message can carry BOTH a story card and a tree-changes card (a turn that
  // drafts a story and stages people edits) — each card has its own result slot and
  // discard flag, so resolving one never hides or resurrects the other.
  const [storyDiscarded, setStoryDiscarded] = useState(false);
  const [peopleDiscarded, setPeopleDiscarded] = useState(false);

  const storySettled = Boolean(msg.result) || storyDiscarded;
  const peopleSettled = Boolean(msg.peopleResult) || peopleDiscarded;

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
          {msg.transcriptionFailed && (
            <Text size="xs" c="dimmed">
              {t.chat.transcriptionFailed}
            </Text>
          )}
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

      {msg.result && (
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

      {msg.peopleResult && (
        <>
          {msg.peopleResult.receipts.length ? (
            <ActionReceipts receipts={msg.peopleResult.receipts} />
          ) : null}
          {msg.peopleResult.errors.length ? (
            <Text size="xs" c="dimmed">
              {t.chat.changesPartlyFailed(msg.peopleResult.errors.length)}
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
          messageId={msg.peopleDraftMessageId ?? null}
          busy={busy}
          setBusy={setBusy}
          onDiscard={() => setPeopleDiscarded(true)}
          onResult={onPeopleResult}
        />
      )}
    </Stack>
  );
}
