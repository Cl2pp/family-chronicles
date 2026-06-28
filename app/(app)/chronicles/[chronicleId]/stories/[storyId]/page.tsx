import { notFound } from 'next/navigation';
import {
  Alert,
  Anchor,
  Badge,
  Card,
  Group,
  Image,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { requireUser } from '@/lib/session';
import { requireMembership, canEdit } from '@/lib/chronicles';
import { getStoryWithSubmitter, listAssets } from '@/lib/stories';
import { presignGet } from '@/lib/s3';
import { formatEventDate } from '@/lib/dates';
import { storyStatusMeta, type StoryStatus } from '@/lib/story-status';
import { AutoRefresh } from '@/components/auto-refresh';
import { StoryBody } from './story-body';
import { RetryButton } from './retry-button';
import { AddPhotos } from './add-photos';

function formatAdded(date: Date): string {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(date);
}

export default async function StoryPage({
  params,
}: {
  params: Promise<{ chronicleId: string; storyId: string }>;
}) {
  const { chronicleId, storyId } = await params;
  const user = await requireUser();
  const membership = await requireMembership(chronicleId, user.id);
  const story = await getStoryWithSubmitter(chronicleId, storyId);
  if (!story) notFound();

  const dateLabel = formatEventDate(story.eventDate, story.eventDatePrecision);
  const status = story.status as StoryStatus;
  const meta = storyStatusMeta(status);
  const editable = canEdit(membership.role);

  const storyAssets = await listAssets(storyId);
  const audio = storyAssets.find((a) => a.kind === 'audio');
  const audioUrl = audio ? await presignGet(audio.s3Key) : null;

  const photoAssets = storyAssets.filter((a) => a.kind === 'photo');
  const photos = await Promise.all(
    photoAssets.map(async (p) => ({ id: p.id, url: await presignGet(p.s3Key) })),
  );

  return (
    <Stack gap="md">
      {/* Keep the page live while the worker is retelling the story. */}
      <AutoRefresh active={status === 'processing'} />

      <Anchor href={`/chronicles/${chronicleId}`} size="sm">
        ← Back to chronicle
      </Anchor>

      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={2}>{story.title}</Title>
          <Text c="dimmed" size="sm">
            By {story.submitterName}
            {dateLabel ? ` · ${dateLabel}` : ''}
          </Text>
        </div>
        <Badge variant="light" color={meta.color}>
          {meta.label}
        </Badge>
      </Group>

      {status === 'processing' ? (
        <Alert color="yellow" variant="light">
          We&rsquo;re retelling this story in the family&rsquo;s voice. This page updates
          automatically when it&rsquo;s ready.
        </Alert>
      ) : null}

      {status === 'failed' ? (
        <Alert
          color="red"
          variant="light"
          icon={<IconAlertTriangle size={18} />}
          title="We couldn't retell this story"
        >
          <Stack gap="xs" align="flex-start">
            <Text size="sm">{story.errorMessage ?? 'Something went wrong.'}</Text>
            {editable ? <RetryButton chronicleId={chronicleId} storyId={storyId} /> : null}
          </Stack>
        </Alert>
      ) : null}

      {audioUrl ? (
        <Card withBorder radius="md" padding="md">
          <Text size="sm" fw={500} mb="xs">
            Original recording
          </Text>
          <audio controls src={audioUrl} style={{ width: '100%' }} />
        </Card>
      ) : null}

      {story.bodyOriginal || story.bodyStyled ? (
        <Card withBorder radius="md" padding="lg">
          <StoryBody styled={story.bodyStyled} original={story.bodyOriginal} />
        </Card>
      ) : null}

      {photos.length > 0 || editable ? (
        <Card withBorder radius="md" padding="md">
          <Text size="sm" fw={500} mb="xs">
            Photos
          </Text>
          {photos.length > 0 ? (
            <SimpleGrid cols={{ base: 2, sm: 3 }} spacing="xs" mb={editable ? 'md' : 0}>
              {photos.map((p) => (
                <a key={p.id} href={p.url} target="_blank" rel="noreferrer">
                  <Image src={p.url} radius="sm" h={150} fit="cover" alt="" />
                </a>
              ))}
            </SimpleGrid>
          ) : null}
          {editable ? <AddPhotos chronicleId={chronicleId} storyId={storyId} /> : null}
        </Card>
      ) : null}

      <Card withBorder radius="md" padding="md">
        <Text size="sm" fw={500} mb="xs">
          About this story
        </Text>
        <Text size="sm" c="dimmed">
          Submitted by {story.submitterName}
        </Text>
        <Text size="sm" c="dimmed">
          Source: {story.inputType === 'voice' ? 'Voice recording' : 'Written'}
        </Text>
        <Text size="sm" c="dimmed">
          Added {formatAdded(story.createdAt)}
        </Text>
      </Card>
    </Stack>
  );
}
