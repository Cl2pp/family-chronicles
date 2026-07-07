'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Badge,
  Button,
  Card,
  Divider,
  Group,
  Radio,
  Stack,
  Text,
} from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import type { AccessRole } from '@/lib/permissions';
import { useI18n } from '@/lib/i18n/client';

export interface ChronicleRow {
  id: string;
  name: string;
  description: string | null;
  role: AccessRole;
  createdLabel: string;
}

const ROLE_COLOR: Record<AccessRole, string> = {
  owner: 'brand',
  contributor: 'teal',
  viewer: 'gray',
};

export function ChroniclesCard({
  chronicles,
  activeId,
}: {
  chronicles: ChronicleRow[];
  activeId: string | null;
}) {
  const router = useRouter();
  const { t } = useI18n();

  function setActive(id: string) {
    document.cookie = `activeChronicleId=${id}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  }

  if (chronicles.length === 0) {
    return (
      <Card withBorder radius="md" p="lg">
        <Stack align="flex-start" gap="xs">
          <Text fw={600}>{t.chroniclesCard.noChroniclesYet}</Text>
          <Text size="sm" c="dimmed">
            {t.chroniclesCard.createFirstHint}
          </Text>
          <Button component={Link} href="/chronicle/new" mt="xs">
            {t.chroniclesCard.startYourChronicle}
          </Button>
        </Stack>
      </Card>
    );
  }

  return (
    <Card withBorder radius="md" p="lg">
      <Radio.Group value={activeId ?? undefined} onChange={setActive}>
        <Stack gap={0}>
          {chronicles.map((chronicle, i) => (
            <Stack key={chronicle.id} gap={0}>
              {i > 0 && <Divider my="sm" />}
              <Group justify="space-between" align="flex-start">
                <Group wrap="nowrap" align="flex-start" gap="sm">
                  <Radio
                    value={chronicle.id}
                    mt={3}
                    aria-label={t.chroniclesCard.useChronicleAria(chronicle.name)}
                  />
                  <Stack gap={2}>
                    <Group gap="xs">
                      <Text fw={600}>{chronicle.name}</Text>
                      <Badge size="sm" variant="light" color={ROLE_COLOR[chronicle.role]}>
                        {t.roles[chronicle.role]}
                      </Badge>
                      {chronicle.id === activeId && (
                        <Badge size="sm" variant="outline">
                          {t.chroniclesCard.activeBadge}
                        </Badge>
                      )}
                    </Group>
                    {chronicle.description && (
                      <Text size="sm" c="dimmed">
                        {chronicle.description}
                      </Text>
                    )}
                    <Text size="xs" c="dimmed">
                      {t.chroniclesCard.created(chronicle.createdLabel)}
                    </Text>
                  </Stack>
                </Group>
                {chronicle.id === activeId && (
                  <Button component={Link} href="/chronicle" variant="subtle" size="xs">
                    {t.chroniclesCard.open}
                  </Button>
                )}
              </Group>
            </Stack>
          ))}
        </Stack>
      </Radio.Group>
      <Divider my="sm" />
      <Group justify="flex-end">
        <Button
          component={Link}
          href="/chronicle/new"
          variant="default"
          size="xs"
          leftSection={<IconPlus size={14} />}
        >
          {t.chroniclesCard.newChronicle}
        </Button>
      </Group>
    </Card>
  );
}
