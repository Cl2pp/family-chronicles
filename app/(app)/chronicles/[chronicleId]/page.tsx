import { notFound } from 'next/navigation';
import { Badge, Group, Stack, Text, Title } from '@mantine/core';
import { requireUser } from '@/lib/session';
import { requireMembership, getChronicle, listMembers, canEdit } from '@/lib/chronicles';
import { listPendingInvitations } from '@/lib/invitations';
import { listStories, listPhotoCounts } from '@/lib/stories';
import { env } from '@/lib/env';
import { ChronicleView } from './chronicle-view';

export default async function ChroniclePage({
  params,
}: {
  params: Promise<{ chronicleId: string }>;
}) {
  const { chronicleId } = await params;
  const user = await requireUser();
  const membership = await requireMembership(chronicleId, user.id);
  const chronicle = await getChronicle(chronicleId);
  if (!chronicle) notFound();

  const editable = canEdit(membership.role);
  const members = await listMembers(chronicleId);
  const pendingRows = editable ? await listPendingInvitations(chronicleId) : [];
  const pending = pendingRows.map((inv) => ({
    id: inv.id,
    email: inv.email,
    role: inv.role,
    url: `${env.BETTER_AUTH_URL}/invite/${inv.token}`,
  }));
  const stories = await listStories(chronicleId);
  const photoRows = await listPhotoCounts(chronicleId);
  const photoCounts = Object.fromEntries(photoRows.map((r) => [r.storyId, r.count]));

  return (
    <Stack gap="lg">
      <div>
        <Group justify="space-between" align="flex-start">
          <Title order={2}>{chronicle.name}</Title>
          <Badge variant="light" color={membership.role === 'owner' ? 'sienna' : 'gray'}>
            {membership.role}
          </Badge>
        </Group>
        {chronicle.description ? (
          <Text c="dimmed" mt={4}>
            {chronicle.description}
          </Text>
        ) : null}
      </div>

      <ChronicleView
        chronicleId={chronicleId}
        editable={editable}
        styleGuide={chronicle.styleGuide ?? ''}
        currentUserId={user.id}
        members={members.map((m) => ({
          userId: m.userId,
          name: m.name,
          email: m.email,
          role: m.role,
        }))}
        pending={pending}
        stories={stories}
        photoCounts={photoCounts}
      />
    </Stack>
  );
}
