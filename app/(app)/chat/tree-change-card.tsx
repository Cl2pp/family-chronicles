'use client';

import { Button, Card, Group, Text } from '@mantine/core';
import { IconSparkles } from '@tabler/icons-react';
import type { TreeProposal } from '@/lib/ai/chat';
import { acceptTree } from './actions';
import type { MsgResult } from './types';

/** Proposed family-tree change (add/relate a person), with accept/discard. */
export function TreeChangeCard({
  proposal,
  family,
  busy,
  setBusy,
  onDiscard,
  onResult,
}: {
  proposal: TreeProposal;
  family: { id: string; name: string };
  busy: boolean;
  setBusy: (b: boolean) => void;
  onDiscard: () => void;
  onResult: (r: MsgResult) => void;
}) {
  async function accept() {
    setBusy(true);
    try {
      await acceptTree({ familyId: family.id, proposal });
      onResult({ kind: 'tree', name: proposal.personName });
    } finally {
      setBusy(false);
    }
  }

  const rel =
    proposal.relativeName && proposal.relation
      ? `${proposal.relation} of ${proposal.relativeName}`
      : 'new person';
  const years =
    proposal.bornYear || proposal.diedYear
      ? ` · ${proposal.bornYear ?? ''}–${proposal.diedYear ?? ''}`
      : '';

  return (
    <Card withBorder radius="md" p="md" maw={480} w="100%">
      <Group gap={6} mb="xs">
        <IconSparkles size={15} color="var(--mantine-color-brand-6)" />
        <Text size="xs" fw={600} c="brand.7" tt="uppercase">
          Tree change · {family.name}
        </Text>
      </Group>
      <Text fw={600}>{proposal.personName}</Text>
      <Text size="sm" c="dimmed" mb="md">
        {rel}
        {years}
      </Text>
      <Group gap="xs">
        <Button size="xs" onClick={accept} loading={busy}>
          Add to tree
        </Button>
        <Button size="xs" variant="default" onClick={onDiscard} disabled={busy}>
          Not now
        </Button>
      </Group>
    </Card>
  );
}
