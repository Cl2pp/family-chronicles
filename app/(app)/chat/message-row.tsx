'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Badge, Group, Paper, Stack, Text } from '@mantine/core';
import { IconCheck } from '@tabler/icons-react';
import type { Proposal } from '@/lib/ai/chat';
import { MessageAttachments } from './message-attachments';
import { StoryDraftCard } from './story-draft-card';
import { TreeChangeCard } from './tree-change-card';
import type { Msg, MsgResult } from './types';

export function MessageRow({
  msg,
  family,
  conversationId,
  onResult,
}: {
  msg: Msg;
  family: { id: string; name: string };
  conversationId: string | null;
  onResult: (r: MsgResult) => void;
}) {
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
    <Stack gap="xs" align="flex-start">
      <Paper bg="slate.1" p="sm" radius="md" maw="80%">
        <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
          {msg.content}
        </Text>
      </Paper>
      {msg.result?.kind === 'story' && (
        <Badge
          color="green"
          variant="light"
          leftSection={<IconCheck size={12} />}
          component={Link}
          href={`/stories/${msg.result.storyId}`}
          style={{ cursor: 'pointer' }}
        >
          Saved to {family.name} — View story
        </Badge>
      )}
      {msg.result?.kind === 'tree' && (
        <Badge color="green" variant="light" leftSection={<IconCheck size={12} />}>
          Added {msg.result.name} to the tree
        </Badge>
      )}
      {msg.proposal && !msg.result && (
        <ProposalCard
          proposal={msg.proposal}
          family={family}
          conversationId={conversationId}
          onResult={onResult}
        />
      )}
    </Stack>
  );
}

function ProposalCard({
  proposal,
  family,
  conversationId,
  onResult,
}: {
  proposal: Proposal;
  family: { id: string; name: string };
  conversationId: string | null;
  onResult: (r: MsgResult) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [discarded, setDiscarded] = useState(false);
  if (discarded) return null;

  if (proposal.kind === 'story') {
    return (
      <StoryDraftCard
        proposal={proposal}
        family={family}
        conversationId={conversationId}
        busy={busy}
        setBusy={setBusy}
        onDiscard={() => setDiscarded(true)}
        onResult={onResult}
      />
    );
  }
  return (
    <TreeChangeCard
      proposal={proposal}
      family={family}
      busy={busy}
      setBusy={setBusy}
      onDiscard={() => setDiscarded(true)}
      onResult={onResult}
    />
  );
}
