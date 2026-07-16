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
import { personFullName } from '@/lib/person-name';
import { invite, linkMemberPersonAction, unlinkMemberPersonAction } from './actions';
import type { InviteRow, MemberRow } from './types';
import { initials } from './utils';

/** A person of the active chronicle's tree, for the link pickers. */
export interface TreePersonOption {
  id: string;
  firstName: string;
  familyName: string | null;
  userId: string | null;
}

export function AccessTab({
  chronicleId,
  members,
  invites,
  canManage: manage,
  treePeople,
}: {
  chronicleId: string;
  members: MemberRow[];
  invites: InviteRow[];
  canManage: boolean;
  treePeople: TreePersonOption[];
}) {
  const { t } = useI18n();
  const [opened, setOpened] = useState(false);
  const [pending, startTransition] = useTransition();
  const [linkPending, startLinkTransition] = useTransition();
  const [link, setLink] = useState<string | null>(null);
  const [linkTarget, setLinkTarget] = useState<MemberRow | null>(null);
  const [linkPersonId, setLinkPersonId] = useState<string | null>(null);
  const form = useForm({
    initialValues: { email: '', role: 'contributor' as AccessRole, personId: '' },
    validate: {
      email: (v) => (/^\S+@\S+\.\S+$/.test(v) ? null : t.auth.enterValidEmail),
    },
  });

  // Only tree people without an account can be linked ('' = not in the tree yet).
  const unlinkedPeople = treePeople.filter((p) => !p.userId);
  const personOptions = unlinkedPeople.map((p) => ({ value: p.id, label: personFullName(p) }));

  function openInvite() {
    form.reset();
    setLink(null);
    setOpened(true);
  }

  function handleSubmit(values: typeof form.values) {
    startTransition(async () => {
      try {
        const { token } = await invite({
          chronicleId,
          email: values.email,
          role: values.role,
          personId: values.personId || null,
        });
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

  function handleLink() {
    if (!linkTarget || !linkPersonId) return;
    const userId = linkTarget.userId;
    startLinkTransition(async () => {
      try {
        await linkMemberPersonAction({ chronicleId, userId, personId: linkPersonId });
        setLinkTarget(null);
        notifications.show({ message: t.access.memberLinked });
      } catch (e) {
        notifications.show({
          color: 'red',
          message: e instanceof Error ? e.message : t.access.couldNotLink,
        });
      }
    });
  }

  function handleUnlink(member: MemberRow) {
    startLinkTransition(async () => {
      try {
        await unlinkMemberPersonAction({ chronicleId, userId: member.userId });
        notifications.show({ message: t.access.memberUnlinked });
      } catch (e) {
        notifications.show({
          color: 'red',
          message: e instanceof Error ? e.message : t.access.couldNotUnlink,
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
                      <Text size="xs" c="dimmed">
                        {m.personName ? t.access.inTreeAs(m.personName) : t.access.notLinkedToTree}
                      </Text>
                    </div>
                  </Group>
                </Table.Td>
                <Table.Td style={{ textAlign: 'right' }}>
                  <Group justify="flex-end" gap="xs" wrap="nowrap">
                    {manage &&
                      (m.personId ? (
                        <Button
                          size="compact-xs"
                          variant="subtle"
                          color="slate"
                          loading={linkPending}
                          onClick={() => handleUnlink(m)}
                        >
                          {t.access.unlink}
                        </Button>
                      ) : (
                        <Button
                          size="compact-xs"
                          variant="subtle"
                          onClick={() => {
                            setLinkPersonId(null);
                            setLinkTarget(m);
                          }}
                        >
                          {t.access.linkToTree}
                        </Button>
                      ))}
                    <Badge variant="light" color="slate">
                      {t.roles[m.role]}
                    </Badge>
                  </Group>
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
                      {i.personName && (
                        <Text size="xs" c="dimmed">
                          {t.access.willJoinAs(i.personName)}
                        </Text>
                      )}
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
              <Select
                label={t.access.treePersonLabel}
                data={[{ value: '', label: t.access.notInTreeYet }, ...personOptions]}
                allowDeselect={false}
                {...form.getInputProps('personId')}
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

      <Modal
        opened={linkTarget !== null}
        onClose={() => setLinkTarget(null)}
        title={t.access.linkModalTitle}
        radius="md"
      >
        <Stack>
          {personOptions.length === 0 ? (
            <Text size="sm" c="dimmed">
              {t.access.noUnlinkedPeople}
            </Text>
          ) : (
            <Select
              label={linkTarget ? t.access.linkModalText(linkTarget.name) : undefined}
              placeholder={t.access.treePersonPlaceholder}
              data={personOptions}
              value={linkPersonId}
              onChange={setLinkPersonId}
              allowDeselect={false}
            />
          )}
          <Group justify="flex-end" mt="sm">
            <Button variant="default" onClick={() => setLinkTarget(null)}>
              {t.common.cancel}
            </Button>
            <Button
              onClick={handleLink}
              loading={linkPending}
              disabled={!linkPersonId}
            >
              {t.access.link}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
