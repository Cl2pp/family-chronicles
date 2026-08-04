import { Box, Button, Card, Stack, Text, Title } from '@mantine/core';
import { IconUsersPlus } from '@tabler/icons-react';
import { requireUser } from '@/lib/session';
import { listMembers } from '@/lib/chronicles';
import { getActiveChronicle } from '@/lib/active-chronicle';
import { getTreeForChronicle } from '@/lib/people';
import { listPendingInvitations } from '@/lib/invitations';
import { getJoinLink, listJoinRequests } from '@/lib/join-links';
import { canManage, type AccessRole } from '@/lib/permissions';
import { getI18n } from '@/lib/i18n/server';
import { ChronicleTabs } from './chronicle-tabs';

export default async function ChroniclePage() {
  const user = await requireUser();
  const { t } = await getI18n();

  const { chronicles, active } = await getActiveChronicle(user.id);

  if (chronicles.length === 0 || !active) {
    return (
      <Box p="lg" maw={1100} mx="auto">
        <Card withBorder radius="md" py={48}>
          <Stack align="center" gap="md">
            <IconUsersPlus size={48} stroke={1.5} color="var(--mantine-color-brand-6)" />
            <Stack align="center" gap={4}>
              <Title order={3}>{t.chronicleEmpty.title}</Title>
              <Text c="dimmed" ta="center" maw={420}>
                {t.chronicleEmpty.text}
              </Text>
            </Stack>
            <Button component="a" href="/chronicle/new" size="md">
              {t.chronicleEmpty.button}
            </Button>
          </Stack>
        </Card>
      </Box>
    );
  }

  const role = active.role as AccessRole;
  // The signup link is a bearer credential and the requests are the owner's to
  // decide, so neither is even loaded for a plain member — the gate is here, on
  // the server, not in what the access tab chooses to render.
  const manage = canManage(role);

  const [tree, members, invites, joinLink, joinRequests] = await Promise.all([
    getTreeForChronicle(active.id),
    listMembers(active.id),
    listPendingInvitations(active.id),
    manage ? getJoinLink(active.id) : null,
    manage ? listJoinRequests(active.id) : [],
  ]);

  return (
    <Box p="lg" maw={1100} mx="auto">
      <ChronicleTabs
        active={active}
        role={role}
        tree={tree}
        members={members.map((m) => ({ ...m, role: m.role as AccessRole }))}
        invites={invites.map((i) => ({
          id: i.id,
          email: i.email,
          role: i.accessRole as AccessRole,
          personName: i.personName,
          expired: i.expired,
        }))}
        joinLink={
          joinLink
            ? {
                token: joinLink.token,
                requiresApproval: joinLink.requiresApproval,
                role: joinLink.accessRole as AccessRole,
              }
            : null
        }
        joinRequests={joinRequests.map((r) => ({ id: r.id, name: r.name, email: r.email }))}
        currentUserId={user.id}
      />
    </Box>
  );
}
