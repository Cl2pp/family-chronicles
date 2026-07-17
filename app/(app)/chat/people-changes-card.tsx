'use client';

import { Button, Card, Group, List, Text } from '@mantine/core';
import { IconBinaryTree2 } from '@tabler/icons-react';
import { useI18n } from '@/lib/i18n/client';
import type { PeopleDraft } from '@/lib/people-changes';
import { confirmPeopleChanges, discardPeopleChanges } from './actions';
import { describePersonChange } from './people-change-describe';
import type { MsgPeopleResult } from './types';

/**
 * The pending tree-changes confirmation card — mirrors StoryDraftCard's shape (one
 * live card per message, Apply/Discard, best-effort discard). Unlike the story card,
 * individual changes aren't editable here: Apply runs the whole staged batch
 * server-side (confirmPeopleChanges re-reads it from stored metadata, never trusting
 * the client), Discard drops it without touching the tree.
 */
export function PeopleChangesCard({
  draft,
  conversationId,
  messageId,
  busy,
  setBusy,
  onDiscard,
  onResult,
}: {
  draft: PeopleDraft;
  conversationId: string | null;
  /** The stored message carrying this card — apply/discard resolve exactly it. */
  messageId: string | null;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onDiscard: () => void;
  onResult: (r: MsgPeopleResult) => void;
}) {
  const { t } = useI18n();

  async function discard() {
    if (conversationId && messageId) {
      setBusy(true);
      try {
        await discardPeopleChanges({ conversationId, messageId });
      } catch {
        // best-effort — the local discard still applies
      } finally {
        setBusy(false);
      }
    }
    onDiscard();
  }

  async function apply() {
    if (!conversationId || !messageId) return;
    setBusy(true);
    try {
      const { receipts, errors, resolvedElsewhere } = await confirmPeopleChanges({
        conversationId,
        messageId,
      });
      // Resolved on another device / by a chat confirmation — just retire the card;
      // whatever happened there already produced its own receipts.
      if (resolvedElsewhere) onDiscard();
      else onResult({ receipts, errors });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card withBorder radius="md" p="md" maw={560} w="100%">
      <Group gap={6} mb="xs">
        <IconBinaryTree2 size={15} color="var(--mantine-color-brand-6)" />
        <Text size="xs" fw={600} c="brand.7" tt="uppercase">
          {t.chat.treeChanges} · {draft.chronicleName}
        </Text>
      </Group>
      <List size="sm" spacing={4} mb="md">
        {draft.changes.map((change, i) => (
          <List.Item key={i}>{describePersonChange(t.chat, change)}</List.Item>
        ))}
      </List>
      <Group gap="xs">
        <Button size="xs" onClick={apply} loading={busy} disabled={!conversationId || !messageId}>
          {t.chat.applyChanges}
        </Button>
        <Button size="xs" variant="default" onClick={discard} disabled={busy}>
          {t.chat.discard}
        </Button>
      </Group>
    </Card>
  );
}
