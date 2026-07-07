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
import type { AccessRole } from '@/lib/permissions';
import { useI18n } from '@/lib/i18n/client';
import { invite } from './actions';
import type { InviteRow, MemberRow } from './types';
import { initials } from './utils';

export function AccessTab({
  chronicleId,
  members,
  invites,
  canManage: manage,
}: {
  chronicleId: string;
  members: MemberRow[];
  invites: InviteRow[];
  canManage: boolean;
}) {
  const { t } = useI18n();
  const [opened, setOpened] = useState(false);
  const [pending, startTransition] = useTransition();
  const [link, setLink] = useState<string | null>(null);
  const form = useForm({
    initialValues: { email: '', role: 'contributor' as AccessRole },
    validate: {
      email: (v) => (/^\S+@\S+\.\S+$/.test(v) ? null : t.auth.enterValidEmail),
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
        const { token } = await invite({ chronicleId, email: values.email, role: values.role });
        const origin = typeof window !== 'undefined' ? window.location.origin : '';
        setLink(`${origin}/invite/${token}`);
        notifications.show({ message: t.access.invitationCreated });
      } catch (e) {
        notifications.show({
          color: 'red',
          message: e instanceof Error ? e.message : t.access.couldNotCreateInvitation,
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
            {t.access.invite}
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
                    {t.roles[m.role]}
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
            {t.access.pendingInvitations}
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
                        {t.roles[i.role]}
                      </Badge>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Card>
        </div>
      )}

      <Modal
        opened={opened}
        onClose={() => setOpened(false)}
        title={t.access.inviteModalTitle}
        radius="md"
      >
        {link ? (
          <Stack>
            <Text size="sm">{t.access.shareLinkText}</Text>
            <TextInput value={link} readOnly />
            <Group justify="flex-end">
              <CopyButton value={link}>
                {({ copied, copy }) => (
                  <Button
                    leftSection={<IconCopy size={16} />}
                    color={copied ? 'teal' : 'brand'}
                    onClick={copy}
                  >
                    {copied ? t.access.copied : t.access.copyLink}
                  </Button>
                )}
              </CopyButton>
            </Group>
          </Stack>
        ) : (
          <form onSubmit={form.onSubmit(handleSubmit)}>
            <Stack>
              <TextInput
                label={t.access.email}
                placeholder={t.access.emailPlaceholder}
                required
                {...form.getInputProps('email')}
              />
              <Select
                label={t.access.role}
                data={[
                  { value: 'viewer', label: t.roles.viewer },
                  { value: 'contributor', label: t.roles.contributor },
                  { value: 'owner', label: t.roles.owner },
                ]}
                allowDeselect={false}
                {...form.getInputProps('role')}
              />
              <Group justify="flex-end" mt="sm">
                <Button variant="default" onClick={() => setOpened(false)}>
                  {t.common.cancel}
                </Button>
                <Button type="submit" loading={pending}>
                  {t.access.createInvitation}
                </Button>
              </Group>
            </Stack>
          </form>
        )}
      </Modal>
    </Stack>
  );
}
