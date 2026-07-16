'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ActionIcon,
  Badge,
  Box,
  Collapse,
  Group,
  Paper,
  Select,
  Stack,
  Tabs,
  Text,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { IconBinaryTree2, IconChevronDown, IconUsers } from '@tabler/icons-react';
import type { FamilyTree as MergedTree, TreePerson } from '@/lib/people';
import { canContribute, canManage, type AccessRole } from '@/lib/permissions';
import { useI18n } from '@/lib/i18n/client';
import { FamilyTree } from './family-tree';
import { AddPersonModal } from './add-person-modal';
import { EditPersonModal } from './edit-person-modal';
import { AccessTab } from './access-tab';
import type { AddTarget, ChronicleRow, InviteRow, MemberRow, PersonRow } from './types';

// 12 hues × 3 shades = 36 distinct colors before the cycle repeats. Neighboring
// hues are ordered for contrast; green ('green') is skipped as too close to brand.
const PALETTE = [
  'brand',
  'grape',
  'teal',
  'orange',
  'pink',
  'cyan',
  'lime',
  'violet',
  'red',
  'indigo',
  'blue',
  'yellow',
];
const SHADES = [6, 8, 4];

function familyColor(i: number): string {
  const hue = PALETTE[i % PALETTE.length];
  const shade = SHADES[Math.floor(i / PALETTE.length) % SHADES.length];
  return `var(--mantine-color-${hue}-${shade})`;
}

interface ChronicleTabsProps {
  active: ChronicleRow;
  role: AccessRole;
  chronicles: ChronicleRow[];
  tree: MergedTree;
  members: MemberRow[];
  invites: InviteRow[];
  currentUserId: string;
}

export function ChronicleTabs({
  active,
  role,
  chronicles,
  tree,
  members,
  invites,
  currentUserId,
}: ChronicleTabsProps) {
  const router = useRouter();
  const { t } = useI18n();
  const [addState, setAddState] = useState<{ opened: boolean; target?: AddTarget }>({
    opened: false,
  });
  const [editState, setEditState] = useState<{ opened: boolean; person: PersonRow | null }>({
    opened: false,
    person: null,
  });
  const [familiesOpen, setFamiliesOpen] = useState(true);
  // Hover previews a family highlight; click pins it (hover still wins while active,
  // and pinning is the only way to highlight on touch devices).
  const [hoverTag, setHoverTag] = useState<string | null>(null);
  const [pinnedTag, setPinnedTag] = useState<string | null>(null);
  const highlightTag = hoverTag ?? pinnedTag;

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
  familyTags.forEach((family, i) => {
    colorByTag[family.tag] = familyColor(i);
  });

  const openAdd = (target?: AddTarget) => setAddState({ opened: true, target });
  const closeAdd = () => setAddState((s) => ({ ...s, opened: false }));

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start">
        <Title order={2}>{t.tree.pageTitle}</Title>
        {chronicles.length > 1 && (
          <Select
            aria-label={t.tree.activeChronicleAria}
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
            {t.tree.tabTree}
          </Tabs.Tab>
          <Tabs.Tab value="access" leftSection={<IconUsers size={16} />}>
            {t.tree.tabAccess}
          </Tabs.Tab>
        </Tabs.List>

        {/* ── Tree ─────────────────────────────────────────────────────── */}
        <Tabs.Panel value="tree" pt="lg">
          <Stack gap="md">
            {familyTags.length > 0 && (
              <Paper withBorder radius="md" p="md">
                <UnstyledButton
                  onClick={() => setFamiliesOpen((o) => !o)}
                  aria-label={t.tree.familiesToggleAria}
                  aria-expanded={familiesOpen}
                  w="100%"
                >
                  <Group justify="space-between" align="center" wrap="nowrap">
                    <Group gap="xs" align="center" wrap="nowrap">
                      <Text size="sm" fw={600}>
                        {t.tree.familiesTitle}
                      </Text>
                      <Badge size="sm" variant="light" color="gray" radius="sm">
                        {familyTags.length}
                      </Badge>
                    </Group>
                    <ActionIcon component="div" variant="subtle" color="gray">
                      <IconChevronDown
                        size={16}
                        style={{
                          transform: familiesOpen ? 'rotate(180deg)' : undefined,
                          transition: 'transform 150ms ease',
                        }}
                      />
                    </ActionIcon>
                  </Group>
                </UnstyledButton>
                <Collapse expanded={familiesOpen}>
                  <Text size="xs" c="dimmed" mt="xs">
                    {t.tree.familiesHint}
                  </Text>
                  <Group gap="lg" mt="sm">
                    {familyTags.map(({ tag, count }) => (
                      <UnstyledButton
                        key={tag}
                        aria-pressed={pinnedTag === tag}
                        onMouseEnter={() => setHoverTag(tag)}
                        onMouseLeave={() =>
                          setHoverTag((current) => (current === tag ? null : current))
                        }
                        onClick={() =>
                          setPinnedTag((current) => (current === tag ? null : tag))
                        }
                        px={6}
                        py={2}
                        style={{
                          borderRadius: 'var(--mantine-radius-sm)',
                          background:
                            pinnedTag === tag ? 'var(--mantine-color-slate-1)' : undefined,
                        }}
                      >
                        <Group gap={8} wrap="nowrap">
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
                      </UnstyledButton>
                    ))}
                  </Group>
                </Collapse>
              </Paper>
            )}

            <FamilyTree
              people={tree.people as TreePerson[]}
              edges={tree.edges}
              colorByTag={colorByTag}
              highlightTag={highlightTag}
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
