'use client';

import {
  Avatar,
  Badge,
  Button,
  Card,
  CopyButton,
  Group,
  Stack,
  Tabs,
  Text,
  Title,
} from '@mantine/core';
import { IconBook, IconCheck, IconCopy, IconPlus, IconUsers, IconWriting } from '@tabler/icons-react';
import type { StoryListItem } from '@/lib/stories';
import { AutoRefresh } from '@/components/auto-refresh';
import { StoriesView } from '@/components/stories-view';
import { InviteButton } from './invite-button';
import { StyleGuideEditor } from './style-guide-editor';

interface Member {
  userId: string;
  name: string;
  email: string;
  role: 'owner' | 'editor' | 'viewer';
}

interface PendingInvite {
  id: string;
  email: string;
  role: string;
  url: string;
}

function initials(name: string) {
  return name
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export function ChronicleView({
  chronicleId,
  editable,
  styleGuide,
  currentUserId,
  members,
  pending,
  stories,
  photoCounts,
}: {
  chronicleId: string;
  editable: boolean;
  styleGuide: string;
  currentUserId: string;
  members: Member[];
  pending: PendingInvite[];
  stories: StoryListItem[];
  photoCounts: Record<string, number>;
}) {
  const hasProcessing = stories.some((s) => s.status === 'processing');

  return (
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

          {stories.length === 0 ? (
            <Card withBorder radius="md" padding="xl">
              <Stack align="center" gap="xs">
                <Text fw={600}>No stories yet</Text>
                <Text c="dimmed" ta="center" maw={460}>
                  {editable
                    ? 'Add the first story — by writing or speaking it — and it will become part of your family book.'
                    : 'No stories have been added yet.'}
                </Text>
              </Stack>
            </Card>
          ) : (
            <StoriesView chronicleId={chronicleId} stories={stories} photoCounts={photoCounts} />
          )}
        </Stack>
      </Tabs.Panel>

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
                        {m.userId === currentUserId ? ' (you)' : ''}
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
                  {pending.map((inv) => (
                    <Group key={inv.id} justify="space-between">
                      <div>
                        <Text size="sm">{inv.email}</Text>
                        <Text size="xs" c="dimmed">
                          {inv.role}
                        </Text>
                      </div>
                      <CopyButton value={inv.url}>
                        {({ copied, copy }) => (
                          <Button
                            size="xs"
                            variant={copied ? 'filled' : 'default'}
                            onClick={copy}
                            leftSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                          >
                            {copied ? 'Copied' : 'Copy link'}
                          </Button>
                        )}
                      </CopyButton>
                    </Group>
                  ))}
                </Stack>
              </Card>
            </>
          ) : null}
        </Stack>
      </Tabs.Panel>

      <Tabs.Panel value="style" pt="md">
        {editable ? (
          <StyleGuideEditor chronicleId={chronicleId} initialValue={styleGuide} />
        ) : (
          <Card withBorder radius="md" padding="md">
            <Text style={{ whiteSpace: 'pre-wrap' }}>{styleGuide || 'No style guide set yet.'}</Text>
          </Card>
        )}
      </Tabs.Panel>
    </Tabs>
  );
}
