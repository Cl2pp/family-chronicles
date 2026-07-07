'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Box, Group, Paper, Select, Stack, Tabs, Text, Title } from '@mantine/core';
import { IconBinaryTree2, IconSettings, IconUsers } from '@tabler/icons-react';
import type { FamilyTree as MergedTree, TreePerson } from '@/lib/people';
import { canContribute, canManage, type AccessRole } from '@/lib/permissions';
import { FamilyTree } from './family-tree';
import { AddPersonModal } from './add-person-modal';
import { EditPersonModal } from './edit-person-modal';
import { AccessTab } from './access-tab';
import { SettingsTab } from './settings-tab';
import type { AddTarget, ChronicleRow, InviteRow, MemberRow, PersonRow } from './types';

const PALETTE = ['brand', 'grape', 'teal', 'orange', 'pink', 'cyan', 'lime', 'violet', 'red'];

interface ChronicleTabsProps {
  active: ChronicleRow;
  role: AccessRole;
  chronicles: ChronicleRow[];
  tree: MergedTree;
  members: MemberRow[];
  invites: InviteRow[];
  currentUserId: string;
  styleGuide: string;
}

export function ChronicleTabs({
  active,
  role,
  chronicles,
  tree,
  members,
  invites,
  currentUserId,
  styleGuide,
}: ChronicleTabsProps) {
  const router = useRouter();
  const [addState, setAddState] = useState<{ opened: boolean; target?: AddTarget }>({
    opened: false,
  });
  const [editState, setEditState] = useState<{ opened: boolean; person: PersonRow | null }>({
    opened: false,
    person: null,
  });

  function switchChronicle(id: string) {
    document.cookie = `activeChronicleId=${id}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  }

  // Families are derived, not configured: collect every tag on the tree's people,
  // biggest family first, and give each a stable palette color.
  const familyTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of tree.people as TreePerson[]) {
      for (const tag of p.familyTags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }, [tree.people]);

  const colorByTag: Record<string, string> = {};
  familyTags.forEach((t, i) => {
    colorByTag[t.tag] = `var(--mantine-color-${PALETTE[i % PALETTE.length]}-6)`;
  });

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
        {chronicles.length > 1 && (
          <Select
            aria-label="Active chronicle"
            w={200}
            allowDeselect={false}
            value={active.id}
            onChange={(id) => id && switchChronicle(id)}
            data={chronicles.map((f) => ({ value: f.id, label: f.name }))}
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
            {familyTags.length > 0 && (
              <Paper withBorder radius="md" p="md">
                <Group justify="space-between" align="baseline" mb="xs">
                  <Text size="sm" fw={600}>
                    Families
                  </Text>
                  <Text size="xs" c="dimmed">
                    Detected automatically from last names, ancestry, and marriages
                  </Text>
                </Group>
                <Group gap="lg">
                  {familyTags.map(({ tag, count }) => (
                    <Group key={tag} gap={8} wrap="nowrap">
                      <Box
                        w={12}
                        h={12}
                        style={{ borderRadius: '50%', background: colorByTag[tag] }}
                      />
                      <Text size="sm">
                        {tag}
                        <Text span c="dimmed" size="sm">
                          {' '}
                          · {count}
                        </Text>
                      </Text>
                    </Group>
                  ))}
                </Group>
              </Paper>
            )}

            <FamilyTree
              people={tree.people as TreePerson[]}
              edges={tree.edges}
              colorByTag={colorByTag}
              currentUserId={currentUserId}
              activeChronicleId={active.id}
              canEdit={canContribute(role)}
              onAddPerson={openAdd}
              onEditPerson={(person) => setEditState({ opened: true, person })}
            />
          </Stack>
        </Tabs.Panel>

        {/* ── Access ───────────────────────────────────────────────────── */}
        <Tabs.Panel value="access" pt="lg">
          <AccessTab
            chronicleId={active.id}
            members={members}
            invites={invites}
            canManage={canManage(role)}
          />
        </Tabs.Panel>

        {/* ── Settings ─────────────────────────────────────────────────── */}
        <Tabs.Panel value="settings" pt="lg">
          <SettingsTab
            chronicleId={active.id}
            name={active.name}
            description={active.description ?? ''}
            styleGuide={styleGuide}
            canManage={canManage(role)}
          />
        </Tabs.Panel>
      </Tabs>

      <AddPersonModal
        chronicleId={active.id}
        opened={addState.opened}
        target={addState.target}
        onClose={closeAdd}
      />

      <EditPersonModal
        chronicleId={active.id}
        person={editState.person}
        opened={editState.opened}
        onClose={() => setEditState((s) => ({ ...s, opened: false }))}
      />
    </Stack>
  );
}
