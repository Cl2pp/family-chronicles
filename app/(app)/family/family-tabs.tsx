'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Box, Group, Paper, Select, Stack, Tabs, Text, Title } from '@mantine/core';
import { IconBinaryTree2, IconSettings, IconUsers } from '@tabler/icons-react';
import type { FamilyTree as MergedTree, TreePerson } from '@/lib/people';
import { canContribute, canManage, roleLabel, type AccessRole } from '@/lib/permissions';
import { FamilyTree } from './family-tree';
import { AddPersonModal } from './add-person-modal';
import { EditPersonModal } from './edit-person-modal';
import { AccessTab } from './access-tab';
import { SettingsTab } from './settings-tab';
import type { AddTarget, FamilyRow, InviteRow, MemberRow, PersonRow } from './types';

const PALETTE = ['brand', 'grape', 'teal', 'orange', 'pink', 'cyan', 'lime', 'violet', 'red'];

interface FamilyTabsProps {
  active: FamilyRow;
  role: AccessRole;
  families: FamilyRow[];
  tree: MergedTree;
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
  members,
  invites,
  currentUserId,
  styleGuide,
}: FamilyTabsProps) {
  const router = useRouter();
  const [addState, setAddState] = useState<{ opened: boolean; target?: AddTarget }>({
    opened: false,
  });
  const [editState, setEditState] = useState<{ opened: boolean; person: PersonRow | null }>({
    opened: false,
    person: null,
  });

  function switchFamily(id: string) {
    document.cookie = `activeFamilyId=${id}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  }

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
        {families.length > 1 && (
          <Select
            aria-label="Active family"
            w={200}
            allowDeselect={false}
            value={active.id}
            onChange={(id) => id && switchFamily(id)}
            data={families.map((f) => ({ value: f.id, label: f.name }))}
            comboboxProps={{ withinPortal: true }}
          />
        )}
      </Group>

      <Tabs defaultValue="tree" keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="tree" leftSection={<IconBinaryTree2 size={16} />}>
            Tree
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
              activeFamilyId={active.id}
              canEdit={canContribute(role)}
              onAddPerson={openAdd}
              onEditPerson={(person) => setEditState({ opened: true, person })}
            />
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

      <EditPersonModal
        familyId={active.id}
        person={editState.person}
        opened={editState.opened}
        onClose={() => setEditState((s) => ({ ...s, opened: false }))}
      />
    </Stack>
  );
}
