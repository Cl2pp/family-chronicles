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
import {
  invite,
  linkMemberPersonAction,
  resendInviteAction,
  revokeInviteAction,
  unlinkMemberPersonAction,
} from './actions';
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
  // The link modal doubles as the resend view; this drives its title.
  const [resent, setResent] = useState(false);
  // Which invitation is mid-flight, so only that row's controls react — a
  // single boolean would spin every row's button at once.
  const [busyInviteId, setBusyInviteId] = useState<string | null>(null);
  const [, startInviteTransition] = useTransition();
  const [revokeTarget, setRevokeTarget] = useState<InviteRow | null>(null);
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
    setResent(false);
    setOpened(true);
  }

  /** Look an outstanding invite's link back up (and revive its expiry) to send again. */
  function handleResend(row: InviteRow) {
    setBusyInviteId(row.id);
    startInviteTransition(async () => {
      try {
        const { token } = await resendInviteAction({ chronicleId, invitationId: row.id });
        setLink(`${window.location.origin}/invite/${token}`);
        setResent(true);
        setOpened(true);
      } catch (e) {
        notifications.show({
          color: 'red',
          message: e instanceof Error ? e.message : t.access.couldNotResendInvitation,
        });
      } finally {
        setBusyInviteId(null);
      }
    });
  }

  function handleRevoke() {
    if (!revokeTarget) return;
    const invitationId = revokeTarget.id;
    setBusyInviteId(invitationId);
    startInviteTransition(async () => {
      try {
        await revokeInviteAction({ chronicleId, invitationId });
        setRevokeTarget(null);
        notifications.show({ message: t.access.invitationRevoked });
      } catch (e) {
        notifications.show({
          color: 'red',
          message: e instanceof Error ? e.message : t.access.couldNotRevokeInvitation,
        });
      } finally {
        setBusyInviteId(null);
      }
    });
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
                      {/* A phone has no room for a third column, so the badges
                          ride under the address there and the dedicated column
                          takes over from `sm` up. */}
                      <Group gap="xs" mt={6} hiddenFrom="sm">
                        {i.expired && (
                          <Badge variant="light" color="red">
                            {t.access.inviteExpired}
                          </Badge>
                        )}
                        <Badge variant="outline" color="slate">
                          {t.roles[i.role]}
                        </Badge>
                      </Group>
                    </Table.Td>
                    {/* Actions get their own centred column so they line up down
                        the list — sharing a cell with the badges let a row's
                        "expired" badge shove its buttons out of alignment. */}
                    <Table.Td style={{ textAlign: 'center' }}>
                      {manage && (
                        // Allowed to wrap: side by side wherever there is room,
                        // stacked on a phone rather than clipped at the edge.
                        <Group justify="center" gap="xs">
                          <Button
                            size="xs"
                            variant="default"
                            loading={busyInviteId === i.id}
                            onClick={() => handleResend(i)}
                          >
                            {t.access.resendInvitation}
                          </Button>
                          <Button
                            size="xs"
                            variant="light"
                            color="red"
                            // Blocked while this row's link is being fetched, so
                            // it can't be revoked out from under the modal.
                            disabled={busyInviteId === i.id}
                            onClick={() => setRevokeTarget(i)}
                          >
                            {t.access.revokeInvitation}
                          </Button>
                        </Group>
                      )}
                    </Table.Td>
                    <Table.Td visibleFrom="sm" style={{ textAlign: 'right' }}>
                      <Group justify="flex-end" gap="xs" wrap="nowrap">
                        {i.expired && (
                          <Badge variant="light" color="red">
                            {t.access.inviteExpired}
                          </Badge>
                        )}
                        <Badge variant="outline" color="slate">
                          {t.roles[i.role]}
                        </Badge>
                      </Group>
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
        title={resent ? t.access.resendModalTitle : t.access.inviteModalTitle}
        radius="md"
      >
        {link ? (
          <Stack>
            <Text size="sm">{resent ? t.access.resendLinkText : t.access.shareLinkText}</Text>
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
        opened={revokeTarget !== null}
        onClose={() => setRevokeTarget(null)}
        title={t.access.revokeModalTitle}
        radius="md"
      >
        <Stack>
          <Text size="sm">
            {revokeTarget ? t.access.revokeConfirmText(revokeTarget.email) : ''}
          </Text>
          <Group justify="flex-end" mt="sm">
            <Button variant="default" onClick={() => setRevokeTarget(null)}>
              {t.common.cancel}
            </Button>
            <Button
              color="red"
              onClick={handleRevoke}
              loading={revokeTarget !== null && busyInviteId === revokeTarget.id}
            >
              {t.access.revokeInvitation}
            </Button>
          </Group>
        </Stack>
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
