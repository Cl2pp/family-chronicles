import { notFound } from 'next/navigation';
import {
  Avatar,
  Badge,
  Card,
  CopyButton,
  Button,
  Group,
  Stack,
  Tabs,
  Text,
  Title,
} from '@mantine/core';
import {
  IconBook,
  IconCheck,
  IconCopy,
  IconPlus,
  IconUsers,
  IconWriting,
} from '@tabler/icons-react';
import { requireUser } from '@/lib/session';
import { requireMembership, getChronicle, listMembers, canEdit } from '@/lib/chronicles';
import { listPendingInvitations } from '@/lib/invitations';
import { listStories } from '@/lib/stories';
import { formatEventDate } from '@/lib/dates';
import { storyStatusMeta, type StoryStatus } from '@/lib/story-status';
import { env } from '@/lib/env';
import { AutoRefresh } from '@/components/auto-refresh';
import { InviteButton } from './invite-button';
import { StyleGuideEditor } from './style-guide-editor';

function initials(name: string) {
  return name
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

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
  const pending = editable ? await listPendingInvitations(chronicleId) : [];
  const storyList = await listStories(chronicleId);
  const hasProcessing = storyList.some((s) => s.status === 'processing');

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

      <Tabs defaultValue="stories">
        <Tabs.List>
          <Tabs.Tab value="stories" leftSection={<IconBook size={16} />}>
            Stories
          </Tabs.Tab>
          <Tabs.Tab value="people" leftSection={<IconUsers size={16} />}>
            People
          </Tabs.Tab>
          <Tabs.Tab value="style" leftSection={<IconWriting size={16} />}>
            Style guide
          </Tabs.Tab>
        </Tabs.List>

        {/* Stories list. The timeline/bubble views arrive in a later phase. */}
        <Tabs.Panel value="stories" pt="md">
          <AutoRefresh active={hasProcessing} />
          <Stack>
            <Group justify="space-between">
              <Title order={4}>Stories</Title>
              {editable ? (
                <Button
                  component="a"
                  href={`/chronicles/${chronicleId}/stories/new`}
                  leftSection={<IconPlus size={16} />}
                >
                  Add story
                </Button>
              ) : null}
            </Group>

            {storyList.length === 0 ? (
              <Card withBorder radius="md" padding="xl">
                <Stack align="center" gap="xs">
                  <Text fw={600}>No stories yet</Text>
                  <Text c="dimmed" ta="center" maw={460}>
                    {editable
                      ? 'Add the first story — by writing it out — and it will become part of your family book.'
                      : 'No stories have been added yet.'}
                  </Text>
                </Stack>
              </Card>
            ) : (
              <Stack gap="sm">
                {storyList.map((s) => {
                  const meta = storyStatusMeta(s.status as StoryStatus);
                  const date = formatEventDate(s.eventDate, s.eventDatePrecision);
                  const excerpt = (s.bodyStyled ?? s.bodyOriginal ?? '').slice(0, 200);
                  return (
                    <Card
                      key={s.id}
                      component="a"
                      href={`/chronicles/${chronicleId}/stories/${s.id}`}
                      withBorder
                      radius="md"
                      padding="md"
                    >
                      <Group justify="space-between" align="flex-start" mb={4}>
                        <Text fw={600}>{s.title}</Text>
                        <Badge variant="light" color={meta.color}>
                          {meta.label}
                        </Badge>
                      </Group>
                      <Text size="xs" c="dimmed" mb={excerpt ? 6 : 0}>
                        By {s.submitterName}
                        {date ? ` · ${date}` : ''}
                        {s.inputType === 'voice' ? ' · voice' : ''}
                      </Text>
                      {excerpt ? (
                        <Text size="sm" c="dimmed" lineClamp={2}>
                          {excerpt}
                        </Text>
                      ) : null}
                    </Card>
                  );
                })}
              </Stack>
            )}
          </Stack>
        </Tabs.Panel>

        {/* People — members and invitations. */}
        <Tabs.Panel value="people" pt="md">
          <Stack>
            <Group justify="space-between">
              <Title order={4}>Members</Title>
              {editable ? <InviteButton chronicleId={chronicleId} /> : null}
            </Group>

            <Card withBorder radius="md" padding="md">
              <Stack gap="sm">
                {members.map((m) => (
                  <Group key={m.userId} justify="space-between">
                    <Group gap="sm">
                      <Avatar radius="xl" color="sienna" size={32}>
                        {initials(m.name)}
                      </Avatar>
                      <div>
                        <Text size="sm" fw={500}>
                          {m.name}
                          {m.userId === user.id ? ' (you)' : ''}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {m.email}
                        </Text>
                      </div>
                    </Group>
                    <Badge variant="light" color={m.role === 'owner' ? 'sienna' : 'gray'}>
                      {m.role}
                    </Badge>
                  </Group>
                ))}
              </Stack>
            </Card>

            {pending.length > 0 ? (
              <>
                <Title order={5} mt="sm">
                  Pending invitations
                </Title>
                <Card withBorder radius="md" padding="md">
                  <Stack gap="sm">
                    {pending.map((inv) => {
                      const url = `${env.BETTER_AUTH_URL}/invite/${inv.token}`;
                      return (
                        <Group key={inv.id} justify="space-between">
                          <div>
                            <Text size="sm">{inv.email}</Text>
                            <Text size="xs" c="dimmed">
                              {inv.role}
                            </Text>
                          </div>
                          <CopyButton value={url}>
                            {({ copied, copy }) => (
                              <Button
                                size="xs"
                                variant={copied ? 'filled' : 'default'}
                                onClick={copy}
                                leftSection={
                                  copied ? <IconCheck size={14} /> : <IconCopy size={14} />
                                }
                              >
                                {copied ? 'Copied' : 'Copy link'}
                              </Button>
                            )}
                          </CopyButton>
                        </Group>
                      );
                    })}
                  </Stack>
                </Card>
              </>
            ) : null}
          </Stack>
        </Tabs.Panel>

        {/* Style guide. */}
        <Tabs.Panel value="style" pt="md">
          {editable ? (
            <StyleGuideEditor chronicleId={chronicleId} initialValue={chronicle.styleGuide ?? ''} />
          ) : (
            <Card withBorder radius="md" padding="md">
              <Text style={{ whiteSpace: 'pre-wrap' }}>
                {chronicle.styleGuide || 'No style guide set yet.'}
              </Text>
            </Card>
          )}
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
