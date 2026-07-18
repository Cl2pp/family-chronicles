'use client';

import { useState } from 'react';
import { Anchor, Group, Paper, Stack, Text } from '@mantine/core';
import { useI18n } from '@/lib/i18n/client';
import { ActionReceipts } from './action-receipts';
import { MessageAttachments } from './message-attachments';
import { MessageMarkdown } from './message-markdown';
import { PeopleChangesCard } from './people-changes-card';
import { StoryDraftCard } from './story-draft-card';
import type { Msg, MsgPeopleResult, MsgResult } from './types';

/** Transcripts longer than this collapse to a preview — a 20-minute voice note can
 *  produce ~16k characters, which rendered raw would dominate the whole chat. */
const TRANSCRIPT_COLLAPSE_CHARS = 600;
/** Lines visible while collapsed. */
const TRANSCRIPT_PREVIEW_LINES = 6;

/**
 * The text of a user voice bubble: long transcripts start clamped to a few lines
 * with a show more/less toggle. Used for both the persisted message and the pending
 * bubble the streaming path fills in, so the collapse behaves identically in both.
 */
function TranscriptText({ content }: { content: string }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const collapsible = content.length > TRANSCRIPT_COLLAPSE_CHARS;
  return (
    <>
      <Text
        size="sm"
        style={{ whiteSpace: 'pre-wrap' }}
        lineClamp={collapsible && !expanded ? TRANSCRIPT_PREVIEW_LINES : undefined}
      >
        {content}
      </Text>
      {collapsible && (
        <Anchor
          component="button"
          type="button"
          size="sm"
          fw={600}
          // The bubble is brand-on-white-text; the default anchor blue would vanish.
          c="white"
          underline="always"
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? t.chat.showLess : t.chat.showMore}
        </Anchor>
      )}
    </>
  );
}

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
    // Only voice transcriptions collapse — typed messages are as long as the user
    // deliberately made them.
    const isTranscription = msg.attachments?.some((a) => a.kind === 'audio') ?? false;
    return (
      <Group justify="flex-end">
        <Stack gap={6} align="flex-end" maw="80%">
          {msg.content && (
            <Paper bg="brand.6" c="white" p="sm" radius="md">
              {isTranscription ? (
                <TranscriptText content={msg.content} />
              ) : (
                <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                  {msg.content}
                </Text>
              )}
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
