import { cookies } from 'next/headers';
import { Box, Button, Card, Stack, Text, Title } from '@mantine/core';
import { IconUsersPlus } from '@tabler/icons-react';
import { requireUser } from '@/lib/session';
import { getChronicle, listMembers, resolveActiveChronicle } from '@/lib/chronicles';
import { getMergedTreeForUser } from '@/lib/people';
import { listPendingInvitations } from '@/lib/invitations';
import type { AccessRole } from '@/lib/permissions';
import { ChronicleTabs } from './chronicle-tabs';

export default async function ChroniclePage() {
  const user = await requireUser();
  const cookieStore = await cookies();
  const activeCookie = cookieStore.get('activeChronicleId')?.value;

  const { chronicles, active } = await resolveActiveChronicle(user.id, activeCookie);

  if (chronicles.length === 0 || !active) {
    return (
      <Box p="lg" maw={1100} mx="auto">
        <Card withBorder radius="md" py={48}>
          <Stack align="center" gap="md">
            <IconUsersPlus size={48} stroke={1.5} color="var(--mantine-color-brand-6)" />
            <Stack align="center" gap={4}>
              <Title order={3}>Start your chronicle</Title>
              <Text c="dimmed" ta="center" maw={420}>
                Create a private chronicle to collect your family&apos;s stories and build a shared tree
                together.
              </Text>
            </Stack>
            <Button component="a" href="/chronicle/new" size="md">
              Start your chronicle
            </Button>
          </Stack>
        </Card>
      </Box>
    );
  }

  const [tree, members, invites, fullChronicle] = await Promise.all([
    getMergedTreeForUser(user.id),
    listMembers(active.id),
    listPendingInvitations(active.id),
    getChronicle(active.id),
  ]);

  return (
    <Box p="lg" maw={1100} mx="auto">
      <ChronicleTabs
        active={active}
        role={active.role as AccessRole}
        chronicles={chronicles}
        tree={tree}
        members={members.map((m) => ({ ...m, role: m.role as AccessRole }))}
        invites={invites.map((i) => ({
          id: i.id,
          email: i.email,
          role: i.accessRole as AccessRole,
          token: i.token,
        }))}
        currentUserId={user.id}
        styleGuide={fullChronicle?.styleGuide ?? ''}
      />
    </Box>
  );
}
