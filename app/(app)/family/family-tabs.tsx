'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  Avatar,
  Badge,
  Box,
  Button,
  Card,
  Group,
  Paper,
  Stack,
  Table,
  Tabs,
  Text,
  Title,
} from '@mantine/core';
import { IconBinaryTree2, IconPlus, IconSettings, IconUsers } from '@tabler/icons-react';
import type { FamilyTree as MergedTree, TreePerson } from '@/lib/people';
import { canContribute, canManage, roleLabel, type AccessRole } from '@/lib/permissions';
import { FamilyTree } from './family-tree';
import { AddPersonModal } from './add-person-modal';
import { AccessTab } from './access-tab';
import { SettingsTab } from './settings-tab';
import type { AddTarget, FamilyRow, InviteRow, MemberRow, PersonRow } from './types';
import { initials, lifeSpan } from './utils';

const PALETTE = ['brand', 'grape', 'teal', 'orange', 'pink', 'cyan', 'lime', 'violet', 'red'];

interface FamilyTabsProps {
  active: FamilyRow;
  role: AccessRole;
  families: FamilyRow[];
  tree: MergedTree;
  people: PersonRow[];
  members: MemberRow[];
  invites: InviteRow[];
  currentUserId: string;
  styleGuide: string;
}

export function FamilyTabs({
  active,
  role,
  families,
  tree,
  people,
  members,
  invites,
  currentUserId,
  styleGuide,
}: FamilyTabsProps) {
  const [addState, setAddState] = useState<{ opened: boolean; target?: AddTarget }>({
    opened: false,
  });

  // Map each family id -> a stable palette color (by families list order).
  const colorByFamily: Record<string, string> = {};
  families.forEach((f, i) => {
    colorByFamily[f.id] = `var(--mantine-color-${PALETTE[i % PALETTE.length]}-6)`;
  });

  const nameCounts = new Map<string, number>();
  for (const f of families) nameCounts.set(f.name, (nameCounts.get(f.name) ?? 0) + 1);

  const openAdd = (target?: AddTarget) => setAddState({ opened: true, target });
  const closeAdd = () => setAddState((s) => ({ ...s, opened: false }));

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={2}>{active.name}</Title>
          {active.description && (
            <Text c="dimmed" mt={4}>
              {active.description}
            </Text>
          )}
        </div>
        <Button component={Link} href="/family/new" variant="default">
          New family
        </Button>
      </Group>

      <Tabs defaultValue="tree" keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="tree" leftSection={<IconBinaryTree2 size={16} />}>
            Tree
          </Tabs.Tab>
          <Tabs.Tab value="people" leftSection={<IconUsers size={16} />}>
            People
          </Tabs.Tab>
          <Tabs.Tab value="access" leftSection={<IconUsers size={16} />}>
            Access
          </Tabs.Tab>
          <Tabs.Tab value="settings" leftSection={<IconSettings size={16} />}>
            Settings
          </Tabs.Tab>
        </Tabs.List>

        {/* ── Tree ─────────────────────────────────────────────────────── */}
        <Tabs.Panel value="tree" pt="lg">
          <Stack gap="md">
            <Paper withBorder radius="md" p="md">
              <Text size="sm" fw={600} mb="xs">
                Families
              </Text>
              <Group gap="lg">
                {families.map((f) => (
                  <Group key={f.id} gap={8} wrap="nowrap">
                    <Box
                      w={12}
                      h={12}
                      style={{ borderRadius: '50%', background: colorByFamily[f.id] }}
                    />
                    <Text size="sm">
                      {f.name}
                      {(nameCounts.get(f.name) ?? 0) > 1 && (
                        <Text span c="dimmed" size="sm">
                          {' '}
                          — {f.description || roleLabel(f.role)}
                        </Text>
                      )}
                    </Text>
                  </Group>
                ))}
              </Group>
            </Paper>

            <FamilyTree
              people={tree.people as TreePerson[]}
              edges={tree.edges}
              colorByFamily={colorByFamily}
              currentUserId={currentUserId}
              canEdit={canContribute(role)}
              onAddPerson={openAdd}
            />
          </Stack>
        </Tabs.Panel>

        {/* ── People ───────────────────────────────────────────────────── */}
        <Tabs.Panel value="people" pt="lg">
          <Stack gap="md">
            {canContribute(role) && (
              <Group justify="flex-end">
                <Button
                  leftSection={<IconPlus size={16} />}
                  variant="light"
                  onClick={() => openAdd()}
                >
                  Add person
                </Button>
              </Group>
            )}
            <Card withBorder radius="md" p={0}>
              <Table verticalSpacing="sm" horizontalSpacing="md">
                <Table.Tbody>
                  {people.length === 0 && (
                    <Table.Tr>
                      <Table.Td>
                        <Text c="dimmed" p="md">
                          No people in this family yet.
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  )}
                  {people.map((p) => (
                    <Table.Tr key={p.id}>
                      <Table.Td>
                        <Group gap="sm" wrap="nowrap">
                          <Avatar radius="xl" size={36} color="slate">
                            {initials(p.displayName)}
                          </Avatar>
                          <div>
                            <Text fw={600} size="sm">
                              {p.displayName}
                            </Text>
                            {lifeSpan(p.bornOn, p.diedOn) && (
                              <Text size="xs" c="dimmed">
                                {lifeSpan(p.bornOn, p.diedOn)}
                              </Text>
                            )}
                          </div>
                        </Group>
                      </Table.Td>
                      <Table.Td style={{ textAlign: 'right' }}>
                        {p.userId && (
                          <Badge variant="light" color="brand">
                            Account
                          </Badge>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Card>
          </Stack>
        </Tabs.Panel>

        {/* ── Access ───────────────────────────────────────────────────── */}
        <Tabs.Panel value="access" pt="lg">
          <AccessTab
            familyId={active.id}
            members={members}
            invites={invites}
            canManage={canManage(role)}
          />
        </Tabs.Panel>

        {/* ── Settings ─────────────────────────────────────────────────── */}
        <Tabs.Panel value="settings" pt="lg">
          <SettingsTab
            familyId={active.id}
            name={active.name}
            description={active.description ?? ''}
            styleGuide={styleGuide}
            canManage={canManage(role)}
          />
        </Tabs.Panel>
      </Tabs>

      <AddPersonModal
        familyId={active.id}
        opened={addState.opened}
        target={addState.target}
        onClose={closeAdd}
      />
    </Stack>
  );
}
