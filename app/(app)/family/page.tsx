import { cookies } from 'next/headers';
import { Box, Button, Card, Stack, Text, Title } from '@mantine/core';
import { IconUsersPlus } from '@tabler/icons-react';
import { requireUser } from '@/lib/session';
import { getFamily, listMembers, resolveActiveFamily } from '@/lib/families';
import { getMergedTreeForUser, listFamilyPeople } from '@/lib/people';
import { listPendingInvitations } from '@/lib/invitations';
import type { AccessRole } from '@/lib/permissions';
import { FamilyTabs } from './family-tabs';

export default async function FamilyPage() {
  const user = await requireUser();
  const cookieStore = await cookies();
  const activeCookie = cookieStore.get('activeFamilyId')?.value;

  const { families, active } = await resolveActiveFamily(user.id, activeCookie);

  if (families.length === 0 || !active) {
    return (
      <Box p="lg" maw={1100} mx="auto">
        <Card withBorder radius="md" py={48}>
          <Stack align="center" gap="md">
            <IconUsersPlus size={48} stroke={1.5} color="var(--mantine-color-brand-6)" />
            <Stack align="center" gap={4}>
              <Title order={3}>Start your family</Title>
              <Text c="dimmed" ta="center" maw={420}>
                Create a private family circle to collect stories and build a shared tree
                together.
              </Text>
            </Stack>
            <Button component="a" href="/family/new" size="md">
              Start your family
            </Button>
          </Stack>
        </Card>
      </Box>
    );
  }

  const [tree, people, members, invites, fullFamily] = await Promise.all([
    getMergedTreeForUser(user.id),
    listFamilyPeople(active.id),
    listMembers(active.id),
    listPendingInvitations(active.id),
    getFamily(active.id),
  ]);

  return (
    <Box p="lg" maw={1100} mx="auto">
      <FamilyTabs
        active={active}
        role={active.role as AccessRole}
        families={families}
        tree={tree}
        people={people}
        members={members.map((m) => ({ ...m, role: m.role as AccessRole }))}
        invites={invites.map((i) => ({
          id: i.id,
          email: i.email,
          role: i.accessRole as AccessRole,
          token: i.token,
        }))}
        currentUserId={user.id}
        styleGuide={fullFamily?.styleGuide ?? ''}
      />
    </Box>
  );
}
