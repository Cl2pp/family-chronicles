'use client';

import Link from 'next/link';
import { useEffect, useState, useTransition } from 'react';
import {
  Avatar,
  Badge,
  Box,
  Button,
  Card,
  CopyButton,
  Group,
  Modal,
  Paper,
  Select,
  Stack,
  Table,
  Tabs,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import {
  IconBinaryTree2,
  IconCopy,
  IconMailPlus,
  IconPlus,
  IconSettings,
  IconUsers,
} from '@tabler/icons-react';
import type { FamilyTree as MergedTree, TreePerson } from '@/lib/people';
import { canContribute, canManage, roleLabel, type AccessRole } from '@/lib/permissions';
import { FamilyTree } from './family-tree';
import { addPersonAction, invite, saveSettings } from './actions';

const PALETTE = ['brand', 'grape', 'teal', 'orange', 'pink', 'cyan', 'lime', 'violet', 'red'];

export interface AddTarget {
  personId: string;
  personName: string;
  relation: 'parent' | 'child' | 'partner';
}

interface FamilyRow {
  id: string;
  name: string;
  description: string | null;
  role: AccessRole;
}

interface MemberRow {
  userId: string;
  name: string;
  email: string;
  role: AccessRole;
}

interface InviteRow {
  id: string;
  email: string;
  role: AccessRole;
  token: string;
}

interface PersonRow {
  id: string;
  displayName: string;
  familyName: string | null;
  userId: string | null;
  bornOn: Date | string | null;
  diedOn: Date | string | null;
}

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

function yearOf(d: Date | string | null | undefined): number | null {
  if (!d) return null;
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return null;
  return date.getUTCFullYear();
}

function lifeSpan(bornOn: Date | string | null, diedOn: Date | string | null): string {
  const born = yearOf(bornOn);
  const died = yearOf(diedOn);
  if (born && died) return `${born}–${died}`;
  if (born) return `${born}–`;
  if (died) return `–${died}`;
  return '';
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const RELATION_TITLE: Record<AddTarget['relation'], (name: string) => string> = {
  parent: (n) => `Add a parent of ${n}`,
  child: (n) => `Add a child of ${n}`,
  partner: (n) => `Add a partner of ${n}`,
};

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

/* ── Add person modal ─────────────────────────────────────────────────── */

function AddPersonModal({
  familyId,
  opened,
  target,
  onClose,
}: {
  familyId: string;
  opened: boolean;
  target?: AddTarget;
  onClose: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const form = useForm({
    initialValues: { displayName: '', familyName: '', bornYear: '', diedYear: '' },
    validate: {
      displayName: (v) => (v.trim() ? null : 'A name is required'),
      bornYear: (v) => (v === '' || /^\d{1,4}$/.test(v) ? null : 'Use a 4-digit year'),
      diedYear: (v) => (v === '' || /^\d{1,4}$/.test(v) ? null : 'Use a 4-digit year'),
    },
  });

  useEffect(() => {
    if (opened) form.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const title = target
    ? RELATION_TITLE[target.relation](target.personName)
    : 'Add a person';

  function handleSubmit(values: typeof form.values) {
    startTransition(async () => {
      try {
        await addPersonAction({
          familyId,
          displayName: values.displayName,
          familyName: values.familyName || undefined,
          bornYear: values.bornYear ? Number(values.bornYear) : undefined,
          diedYear: values.diedYear ? Number(values.diedYear) : undefined,
          connectTo: target
            ? { personId: target.personId, relation: target.relation }
            : undefined,
        });
        notifications.show({ message: 'Person added' });
        onClose();
      } catch (e) {
        notifications.show({
          color: 'red',
          message: e instanceof Error ? e.message : 'Could not add person',
        });
      }
    });
  }

  return (
    <Modal opened={opened} onClose={onClose} title={title} radius="md">
      <form onSubmit={form.onSubmit(handleSubmit)}>
        <Stack>
          <TextInput
            label="Name"
            placeholder="Full name"
            required
            {...form.getInputProps('displayName')}
          />
          <TextInput
            label="Family name (surname)"
            placeholder="Optional"
            {...form.getInputProps('familyName')}
          />
          <Group grow>
            <TextInput
              label="Birth year"
              placeholder="e.g. 1948"
              {...form.getInputProps('bornYear')}
            />
            <TextInput
              label="Death year"
              placeholder="e.g. 2019"
              {...form.getInputProps('diedYear')}
            />
          </Group>
          <Group justify="flex-end" mt="sm">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Add person
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

/* ── Access tab ───────────────────────────────────────────────────────── */

function AccessTab({
  familyId,
  members,
  invites,
  canManage: manage,
}: {
  familyId: string;
  members: MemberRow[];
  invites: InviteRow[];
  canManage: boolean;
}) {
  const [opened, setOpened] = useState(false);
  const [pending, startTransition] = useTransition();
  const [link, setLink] = useState<string | null>(null);
  const form = useForm({
    initialValues: { email: '', role: 'contributor' as AccessRole },
    validate: {
      email: (v) => (/^\S+@\S+\.\S+$/.test(v) ? null : 'Enter a valid email'),
    },
  });

  function openInvite() {
    form.reset();
    setLink(null);
    setOpened(true);
  }

  function handleSubmit(values: typeof form.values) {
    startTransition(async () => {
      try {
        const { token } = await invite({ familyId, email: values.email, role: values.role });
        const origin = typeof window !== 'undefined' ? window.location.origin : '';
        setLink(`${origin}/invite/${token}`);
        notifications.show({ message: 'Invitation created' });
      } catch (e) {
        notifications.show({
          color: 'red',
          message: e instanceof Error ? e.message : 'Could not create invitation',
        });
      }
    });
  }

  return (
    <Stack gap="md">
      {manage && (
        <Group justify="flex-end">
          <Button
            leftSection={<IconMailPlus size={16} />}
            variant="light"
            onClick={openInvite}
          >
            Invite
          </Button>
        </Group>
      )}

      <Card withBorder radius="md" p={0}>
        <Table verticalSpacing="sm" horizontalSpacing="md">
          <Table.Tbody>
            {members.map((m) => (
              <Table.Tr key={m.userId}>
                <Table.Td>
                  <Group gap="sm" wrap="nowrap">
                    <Avatar radius="xl" size={36} color="slate">
                      {initials(m.name)}
                    </Avatar>
                    <div>
                      <Text fw={600} size="sm">
                        {m.name}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {m.email}
                      </Text>
                    </div>
                  </Group>
                </Table.Td>
                <Table.Td style={{ textAlign: 'right' }}>
                  <Badge variant="light" color="slate">
                    {roleLabel(m.role)}
                  </Badge>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Card>

      {invites.length > 0 && (
        <div>
          <Text size="sm" fw={600} mb="xs">
            Pending invitations
          </Text>
          <Card withBorder radius="md" p={0}>
            <Table verticalSpacing="sm" horizontalSpacing="md">
              <Table.Tbody>
                {invites.map((i) => (
                  <Table.Tr key={i.id}>
                    <Table.Td>
                      <Text size="sm">{i.email}</Text>
                    </Table.Td>
                    <Table.Td style={{ textAlign: 'right' }}>
                      <Badge variant="outline" color="slate">
                        {roleLabel(i.role)}
                      </Badge>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Card>
        </div>
      )}

      <Modal opened={opened} onClose={() => setOpened(false)} title="Invite to family" radius="md">
        {link ? (
          <Stack>
            <Text size="sm">Share this link with the person you invited:</Text>
            <TextInput value={link} readOnly />
            <Group justify="flex-end">
              <CopyButton value={link}>
                {({ copied, copy }) => (
                  <Button
                    leftSection={<IconCopy size={16} />}
                    color={copied ? 'teal' : 'brand'}
                    onClick={copy}
                  >
                    {copied ? 'Copied' : 'Copy link'}
                  </Button>
                )}
              </CopyButton>
            </Group>
          </Stack>
        ) : (
          <form onSubmit={form.onSubmit(handleSubmit)}>
            <Stack>
              <TextInput
                label="Email"
                placeholder="person@example.com"
                required
                {...form.getInputProps('email')}
              />
              <Select
                label="Role"
                data={[
                  { value: 'viewer', label: 'Viewer' },
                  { value: 'contributor', label: 'Contributor' },
                  { value: 'owner', label: 'Owner' },
                ]}
                allowDeselect={false}
                {...form.getInputProps('role')}
              />
              <Group justify="flex-end" mt="sm">
                <Button variant="default" onClick={() => setOpened(false)}>
                  Cancel
                </Button>
                <Button type="submit" loading={pending}>
                  Create invitation
                </Button>
              </Group>
            </Stack>
          </form>
        )}
      </Modal>
    </Stack>
  );
}

/* ── Settings tab ─────────────────────────────────────────────────────── */

function SettingsTab({
  familyId,
  name,
  description,
  styleGuide,
  canManage: manage,
}: {
  familyId: string;
  name: string;
  description: string;
  styleGuide: string;
  canManage: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const form = useForm({
    initialValues: { name, description, styleGuide },
    validate: { name: (v) => (v.trim() ? null : 'A family name is required') },
  });

  function handleSubmit(values: typeof form.values) {
    startTransition(async () => {
      try {
        await saveSettings({ familyId, ...values });
        notifications.show({ message: 'Settings saved' });
        form.resetDirty(values);
      } catch (e) {
        notifications.show({
          color: 'red',
          message: e instanceof Error ? e.message : 'Could not save settings',
        });
      }
    });
  }

  return (
    <Card withBorder radius="md" maw={640}>
      {!manage && (
        <Text c="dimmed" size="sm" mb="md">
          Only owners can change these settings.
        </Text>
      )}
      <form onSubmit={form.onSubmit(handleSubmit)}>
        <Stack>
          <TextInput
            label="Family name"
            required
            disabled={!manage}
            {...form.getInputProps('name')}
          />
          <Textarea
            label="Description"
            autosize
            minRows={2}
            disabled={!manage}
            {...form.getInputProps('description')}
          />
          <Textarea
            label="Writing style"
            description="Guidance injected into the styling prompt when stories are rewritten."
            autosize
            minRows={4}
            disabled={!manage}
            {...form.getInputProps('styleGuide')}
          />
          {manage && (
            <Group justify="flex-end">
              <Button type="submit" loading={pending}>
                Save changes
              </Button>
            </Group>
          )}
        </Stack>
      </form>
    </Card>
  );
}
