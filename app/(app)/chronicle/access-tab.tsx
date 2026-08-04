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
  Radio,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconCopy, IconLink, IconMailPlus } from '@tabler/icons-react';
import type { AccessRole } from '@/lib/permissions';
import { useI18n } from '@/lib/i18n/client';
import { personFullName } from '@/lib/person-name';
import {
  approveJoinRequestAction,
  createJoinLinkAction,
  declineJoinRequestAction,
  invite,
  linkMemberPersonAction,
  resendInviteAction,
  revokeInviteAction,
  revokeJoinLinkAction,
  unlinkMemberPersonAction,
} from './actions';
import type { InviteRow, JoinLinkRow, JoinRequestRow, MemberRow } from './types';
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
  joinLink,
  joinRequests,
  canManage: manage,
  treePeople,
}: {
  chronicleId: string;
  members: MemberRow[];
  invites: InviteRow[];
  /** The chronicle's signup link — only ever sent to owners. */
  joinLink: JoinLinkRow | null;
  joinRequests: JoinRequestRow[];
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
  const [joinLinkPending, startJoinLinkTransition] = useTransition();
  const [createJoinLinkOpen, setCreateJoinLinkOpen] = useState(false);
  const [revokeJoinLinkOpen, setRevokeJoinLinkOpen] = useState(false);
  // The mode is fixed once the link exists, so this only ever drives the create
  // modal. Approval is the default: it is the safe half of the choice.
  const [joinLinkMode, setJoinLinkMode] = useState<'approval' | 'open'>('approval');
  const [joinLinkRole, setJoinLinkRole] = useState<AccessRole>('contributor');
  // Same reasoning as the invite rows: only the request being decided reacts.
  const [busyRequestId, setBusyRequestId] = useState<string | null>(null);
  const [, startRequestTransition] = useTransition();
  // Role picked per request, defaulting to contributor like a fresh invite.
  const [requestRoles, setRequestRoles] = useState<Record<string, AccessRole>>({});
  // Same origin trick as the invite link. Safe to read during render here: the
  // access panel is `keepMounted={false}`, so it only ever mounts in the browser
  // — there is no server render of this to disagree with.
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const joinUrl = joinLink ? `${origin}/join/${joinLink.token}` : null;
  const form = useForm({
    initialValues: { email: '', role: 'contributor' as AccessRole, personId: '' },
    validate: {
      email: (v) => (/^\S+@\S+\.\S+$/.test(v) ? null : t.auth.enterValidEmail),
    },
  });

  // Only tree people without an account can be linked ('' = not in the tree yet).
  const unlinkedPeople = treePeople.filter((p) => !p.userId);
  const personOptions = unlinkedPeople.map((p) => ({ value: p.id, label: personFullName(p) }));

  const roleOptions = [
    { value: 'viewer', label: t.roles.viewer },
    { value: 'contributor', label: t.roles.contributor },
    { value: 'owner', label: t.roles.owner },
  ];
  // An open link is a standing grant to anyone it reaches, so ownership is off
  // the menu there (the server refuses it too). Approving a named person as
  // owner stays possible — that is a decision about someone, not about a link.
  const openLinkRoleOptions = roleOptions.filter((r) => r.value !== 'owner');

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

  function openCreateJoinLink() {
    setJoinLinkMode('approval');
    setJoinLinkRole('contributor');
    setCreateJoinLinkOpen(true);
  }

  /** The link itself arrives via the page's revalidation, not from the return value. */
  function handleCreateJoinLink() {
    startJoinLinkTransition(async () => {
      try {
        const { created } = await createJoinLinkAction({
          chronicleId,
          requiresApproval: joinLinkMode === 'approval',
          role: joinLinkRole,
        });
        setCreateJoinLinkOpen(false);
        // The settings just picked only took effect if this actually made the
        // link — say so plainly rather than let the card contradict the toast.
        notifications.show({
          message: created ? t.access.signupLinkCreated : t.access.signupLinkAlreadyExisted,
        });
      } catch (e) {
        notifications.show({
          color: 'red',
          message: e instanceof Error ? e.message : t.access.couldNotCreateSignupLink,
        });
      }
    });
  }

  function handleRevokeJoinLink() {
    startJoinLinkTransition(async () => {
      try {
        await revokeJoinLinkAction({ chronicleId });
        setRevokeJoinLinkOpen(false);
        notifications.show({ message: t.access.signupLinkRevoked });
      } catch (e) {
        notifications.show({
          color: 'red',
          message: e instanceof Error ? e.message : t.access.couldNotRevokeSignupLink,
        });
      }
    });
  }

  function handleApproveRequest(row: JoinRequestRow) {
    setBusyRequestId(row.id);
    startRequestTransition(async () => {
      try {
        await approveJoinRequestAction({
          chronicleId,
          requestId: row.id,
          role: requestRoles[row.id] ?? 'contributor',
        });
        notifications.show({ message: t.access.requestApproved });
      } catch (e) {
        notifications.show({
          color: 'red',
          message: e instanceof Error ? e.message : t.access.couldNotApproveRequest,
        });
      } finally {
        setBusyRequestId(null);
      }
    });
  }

  function handleDeclineRequest(row: JoinRequestRow) {
    setBusyRequestId(row.id);
    startRequestTransition(async () => {
      try {
        await declineJoinRequestAction({ chronicleId, requestId: row.id });
        notifications.show({ message: t.access.requestDeclined });
      } catch (e) {
        notifications.show({
          color: 'red',
          message: e instanceof Error ? e.message : t.access.couldNotDeclineRequest,
        });
      } finally {
        setBusyRequestId(null);
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

      {manage && (
        <div>
          <Text size="sm" fw={600} mb="xs">
            {t.access.signupLinkTitle}
          </Text>
          <Card withBorder radius="md" p="md">
            <Stack gap="sm">
              <Text size="xs" c="dimmed">
                {t.access.signupLinkHint}
              </Text>
              {joinUrl && joinLink ? (
                <>
                  {/* What the link actually does is the one thing an owner must
                      not have to guess, so it sits above the URL, not in a
                      tooltip. Revoking is the only way to change it. */}
                  <Group gap="xs">
                    <Badge
                      variant="light"
                      color={joinLink.requiresApproval ? 'brand' : 'orange'}
                    >
                      {joinLink.requiresApproval
                        ? t.access.signupLinkModeApprovalBadge
                        : t.access.signupLinkModeOpenBadge}
                    </Badge>
                    {!joinLink.requiresApproval && (
                      <Badge variant="outline" color="slate">
                        {t.access.signupLinkGrantsRole(t.roles[joinLink.role])}
                      </Badge>
                    )}
                  </Group>
                  <TextInput value={joinUrl} readOnly aria-label={t.access.signupLinkTitle} />
                  <Group justify="flex-end" gap="xs">
                    <Button
                      variant="light"
                      color="red"
                      onClick={() => setRevokeJoinLinkOpen(true)}
                    >
                      {t.access.revokeSignupLink}
                    </Button>
                    <CopyButton value={joinUrl}>
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
                </>
              ) : (
                <Group justify="flex-end">
                  <Button
                    leftSection={<IconLink size={16} />}
                    variant="light"
                    onClick={openCreateJoinLink}
                  >
                    {t.access.createSignupLink}
                  </Button>
                </Group>
              )}
            </Stack>
          </Card>
        </div>
      )}

      {manage && joinRequests.length > 0 && (
        <div>
          <Text size="sm" fw={600} mb="xs">
            {t.access.joinRequests}
          </Text>
          <Card withBorder radius="md" p={0}>
            <Table verticalSpacing="sm" horizontalSpacing="md">
              <Table.Tbody>
                {joinRequests.map((r) => (
                  <Table.Tr key={r.id}>
                    <Table.Td>
                      <Text size="sm">{r.name}</Text>
                      <Text size="xs" c="dimmed">
                        {r.email}
                      </Text>
                    </Table.Td>
                    <Table.Td style={{ textAlign: 'right' }}>
                      {/* Allowed to wrap: side by side where there is room,
                          stacked on a phone rather than clipped at the edge. */}
                      <Group justify="flex-end" gap="xs">
                        <Select
                          size="xs"
                          w={150}
                          aria-label={t.access.role}
                          data={roleOptions}
                          value={requestRoles[r.id] ?? 'contributor'}
                          onChange={(value) =>
                            setRequestRoles((roles) => ({
                              ...roles,
                              [r.id]: (value as AccessRole) ?? 'contributor',
                            }))
                          }
                          allowDeselect={false}
                        />
                        <Button
                          size="xs"
                          loading={busyRequestId === r.id}
                          onClick={() => handleApproveRequest(r)}
                        >
                          {t.access.approveRequest}
                        </Button>
                        <Button
                          size="xs"
                          variant="light"
                          color="red"
                          disabled={busyRequestId === r.id}
                          onClick={() => handleDeclineRequest(r)}
                        >
                          {t.access.declineRequest}
                        </Button>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Card>
        </div>
      )}

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
                data={roleOptions}
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
        opened={createJoinLinkOpen}
        onClose={() => setCreateJoinLinkOpen(false)}
        title={t.access.createSignupLinkModalTitle}
        radius="md"
      >
        <Stack>
          <Radio.Group
            value={joinLinkMode}
            onChange={(value) => setJoinLinkMode(value as 'approval' | 'open')}
            label={t.access.signupLinkModeLabel}
          >
            <Stack gap="sm" mt="xs">
              <Radio
                value="approval"
                label={t.access.signupLinkModeApproval}
                description={t.access.signupLinkModeApprovalHint}
              />
              <Radio
                value="open"
                label={t.access.signupLinkModeOpen}
                description={t.access.signupLinkModeOpenHint}
              />
            </Stack>
          </Radio.Group>
          {/* Only the open mode needs a role up front — in approval mode the
              owner picks one per request, where they know who is asking. */}
          {joinLinkMode === 'open' && (
            <Select
              label={t.access.signupLinkRoleLabel}
              data={openLinkRoleOptions}
              value={joinLinkRole}
              onChange={(value) => setJoinLinkRole((value as AccessRole) ?? 'contributor')}
              allowDeselect={false}
            />
          )}
          <Group justify="flex-end" mt="sm">
            <Button variant="default" onClick={() => setCreateJoinLinkOpen(false)}>
              {t.common.cancel}
            </Button>
            <Button onClick={handleCreateJoinLink} loading={joinLinkPending}>
              {t.access.createSignupLink}
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={revokeJoinLinkOpen}
        onClose={() => setRevokeJoinLinkOpen(false)}
        title={t.access.revokeSignupLinkModalTitle}
        radius="md"
      >
        <Stack>
          <Text size="sm">{t.access.revokeSignupLinkConfirmText}</Text>
          <Group justify="flex-end" mt="sm">
            <Button variant="default" onClick={() => setRevokeJoinLinkOpen(false)}>
              {t.common.cancel}
            </Button>
            <Button color="red" onClick={handleRevokeJoinLink} loading={joinLinkPending}>
              {t.access.revokeSignupLink}
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
