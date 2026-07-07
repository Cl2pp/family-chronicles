'use client';

import { useState } from 'react';
import { Group, Paper, Stack, Text } from '@mantine/core';
import { useI18n } from '@/lib/i18n/client';
import { ActionReceipts } from './action-receipts';
import { MessageAttachments } from './message-attachments';
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
  const [discarded, setDiscarded] = useState(false);

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
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
            {msg.content}
          </Text>
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

      {msg.storyDraft && !msg.result && !discarded && (
        <StoryDraftCard
          draft={msg.storyDraft}
          conversationId={conversationId}
          busy={busy}
          setBusy={setBusy}
          onDiscard={() => setDiscarded(true)}
          onResult={onResult}
        />
      )}
    </Stack>
  );
}
