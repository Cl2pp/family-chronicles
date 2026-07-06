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
import { roleLabel, type AccessRole } from '@/lib/permissions';

export interface FamilyRow {
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

export function FamiliesCard({
  families,
  activeId,
}: {
  families: FamilyRow[];
  activeId: string | null;
}) {
  const router = useRouter();

  function setActive(id: string) {
    document.cookie = `activeFamilyId=${id}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  }

  if (families.length === 0) {
    return (
      <Card withBorder radius="md" p="lg">
        <Stack align="flex-start" gap="xs">
          <Text fw={600}>No families yet</Text>
          <Text size="sm" c="dimmed">
            Create a family to start collecting stories and building your tree.
          </Text>
          <Button component={Link} href="/family/new" mt="xs">
            Start your family
          </Button>
        </Stack>
      </Card>
    );
  }

  return (
    <Card withBorder radius="md" p="lg">
      <Radio.Group value={activeId ?? undefined} onChange={setActive}>
        <Stack gap={0}>
          {families.map((family, i) => (
            <Stack key={family.id} gap={0}>
              {i > 0 && <Divider my="sm" />}
              <Group justify="space-between" align="flex-start">
                <Group wrap="nowrap" align="flex-start" gap="sm">
                  <Radio value={family.id} mt={3} aria-label={`Use ${family.name}`} />
                  <Stack gap={2}>
                    <Group gap="xs">
                      <Text fw={600}>{family.name}</Text>
                      <Badge size="sm" variant="light" color={ROLE_COLOR[family.role]}>
                        {roleLabel(family.role)}
                      </Badge>
                      {family.id === activeId && (
                        <Badge size="sm" variant="outline">
                          Active
                        </Badge>
                      )}
                    </Group>
                    {family.description && (
                      <Text size="sm" c="dimmed">
                        {family.description}
                      </Text>
                    )}
                    <Text size="xs" c="dimmed">
                      Created {family.createdLabel}
                    </Text>
                  </Stack>
                </Group>
                {family.id === activeId && (
                  <Button component={Link} href="/family" variant="subtle" size="xs">
                    Open
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
          href="/family/new"
          variant="default"
          size="xs"
          leftSection={<IconPlus size={14} />}
        >
          New family
        </Button>
      </Group>
    </Card>
  );
}
