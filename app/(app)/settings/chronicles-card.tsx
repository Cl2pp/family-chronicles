'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Card,
  Collapse,
  Divider,
  Group,
  Radio,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core';
import { IconChevronDown, IconPlus } from '@tabler/icons-react';
import { canManage, type AccessRole } from '@/lib/permissions';
import { useI18n } from '@/lib/i18n/client';
import { ChronicleSettingsForm } from './chronicle-settings-form';

export interface ChronicleRow {
  id: string;
  name: string;
  description: string | null;
  styleGuide: string | null;
  storyLanguage: string | null;
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
  const [expandedId, setExpandedId] = useState<string | null>(activeId);

  function setActive(id: string) {
    document.cookie = `activeChronicleId=${id}; path=/; max-age=31536000; samesite=lax`;
    setExpandedId(id);
    router.refresh();
  }

  function toggleExpanded(id: string) {
    setExpandedId((prev) => (prev === id ? null : id));
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
          {chronicles.map((chronicle, i) => {
            const expanded = expandedId === chronicle.id;
            return (
              <Stack key={chronicle.id} gap={0}>
                {i > 0 && <Divider my="sm" />}
                <Group justify="space-between" align="flex-start" wrap="nowrap">
                  <Group
                    wrap="nowrap"
                    align="flex-start"
                    gap="sm"
                    style={{ flex: 1, minWidth: 0 }}
                  >
                    <Radio
                      value={chronicle.id}
                      mt={3}
                      aria-label={t.chroniclesCard.useChronicleAria(chronicle.name)}
                    />
                    <UnstyledButton
                      onClick={() => toggleExpanded(chronicle.id)}
                      aria-expanded={expanded}
                      style={{ flex: 1, minWidth: 0 }}
                    >
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
                    </UnstyledButton>
                  </Group>
                  <Group gap={4} wrap="nowrap">
                    {chronicle.id === activeId && (
                      <Button component={Link} href="/chronicle" variant="subtle" size="xs">
                        {t.chroniclesCard.open}
                      </Button>
                    )}
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      onClick={() => toggleExpanded(chronicle.id)}
                      aria-label={t.chroniclesCard.toggleSettingsAria(chronicle.name)}
                      aria-expanded={expanded}
                    >
                      <IconChevronDown
                        size={16}
                        style={{
                          transform: expanded ? 'rotate(180deg)' : undefined,
                          transition: 'transform 150ms ease',
                        }}
                      />
                    </ActionIcon>
                  </Group>
                </Group>
                <Collapse expanded={expanded}>
                  <Box pt="md" pb="xs" pl={32}>
                    <ChronicleSettingsForm
                      chronicleId={chronicle.id}
                      name={chronicle.name}
                      description={chronicle.description ?? ''}
                      styleGuide={chronicle.styleGuide ?? ''}
                      storyLanguage={chronicle.storyLanguage}
                      canManage={canManage(chronicle.role)}
                    />
                  </Box>
                </Collapse>
              </Stack>
            );
          })}
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
