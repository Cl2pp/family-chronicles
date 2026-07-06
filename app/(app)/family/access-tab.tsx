'use client';

import { useState, useTransition } from 'react';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CopyButton,
  Group,
  Modal,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconCopy, IconMailPlus } from '@tabler/icons-react';
import { roleLabel, type AccessRole } from '@/lib/permissions';
import { invite } from './actions';
import type { InviteRow, MemberRow } from './types';
import { initials } from './utils';

export function AccessTab({
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
