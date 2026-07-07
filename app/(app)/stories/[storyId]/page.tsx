import { notFound } from 'next/navigation';
import {
  Alert,
  Badge,
  Box,
  Divider,
  Group,
  Image,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { requireUser } from '@/lib/session';
import { canUserEditStory, chroniclesForStory, getStoryForUser, listAssets } from '@/lib/stories';
import { familyTagsByStory } from '@/lib/family-tags';
import { listChroniclesForUser } from '@/lib/chronicles';
import { formatEventDate } from '@/lib/dates';
import { storyStatusMeta } from '@/lib/story-status';
import { presignGet } from '@/lib/s3';
import { RetryButton } from './retry-button';
import { SourceAccordion } from './source-accordion';
import { ShareControl } from './share-control';
import { EditControl } from './edit-control';

function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export default async function StoryDetailPage({
  params,
}: {
  params: Promise<{ storyId: string }>;
}) {
  const { storyId } = await params;
  const user = await requireUser();
  const story = await getStoryForUser(storyId, user.id);
  if (!story) notFound();

  const [shareChronicles, assets, userChronicles, canEdit, tagsByStory] = await Promise.all([
    chroniclesForStory(storyId),
    listAssets(storyId),
    listChroniclesForUser(user.id),
    canUserEditStory(storyId, user.id),
    familyTagsByStory([storyId]),
  ]);
  const familyTags = tagsByStory.get(storyId) ?? [];

  const sharedIds = new Set(shareChronicles.map((f) => f.id));
  const shareCandidates = userChronicles
    .filter((f) => !sharedIds.has(f.id))
    .map((f) => ({ id: f.id, name: f.name }));

  const photoAssets = assets.filter((a) => a.kind === 'photo');
  const audioAsset = assets.find((a) => a.kind === 'audio');

  const [photos, audioUrl] = await Promise.all([
    Promise.all(
      photoAssets.map(async (a) => ({
        id: a.id,
        url: await presignGet(a.s3Key),
        caption: a.caption,
      })),
    ),
    audioAsset ? presignGet(audioAsset.s3Key) : Promise.resolve(null),
  ]);

  const meta = storyStatusMeta(story.status);
  const date = formatEventDate(story.eventDate, story.eventDatePrecision);
  const styledParas = story.bodyStyled ? paragraphs(story.bodyStyled) : [];

  return (
    <Box p="lg" maw={960} mx="auto">
      <Stack gap="xl">
        {/* Header */}
        <Stack gap="sm">
          <Group justify="space-between" align="flex-start" wrap="nowrap">
            <Title order={1}>{story.title}</Title>
            <Badge variant="light" color={meta.color} size="lg">
              {meta.label}
            </Badge>
          </Group>
          <Text c="dimmed">
            By {story.submitterName}
            {date ? ` · ${date}` : ''}
          </Text>
          {familyTags.length > 0 && (
            <Group gap="xs" align="center">
              <Text size="sm" c="dimmed">
                Families
              </Text>
              {familyTags.map((tag) => (
                <Badge key={tag} variant="light" color="slate" radius="sm">
                  {tag}
                </Badge>
              ))}
            </Group>
          )}
          {shareChronicles.length > 1 && (
            <Group gap="xs" align="center">
              <Text size="sm" c="dimmed">
                Shared with
              </Text>
              {shareChronicles.map((f) => (
                <Badge key={f.id} variant="outline" color="slate" radius="sm">
                  {f.name}
                </Badge>
              ))}
            </Group>
          )}
          <ShareControl storyId={story.id} candidates={shareCandidates} />
          {canEdit && story.status === 'ready' && (
            <EditControl
              storyId={story.id}
              initial={{
                title: story.title,
                summary: story.summary ?? '',
                body: story.bodyStyled ?? story.bodyOriginal ?? '',
                eventYear: story.eventDate ? story.eventDate.getUTCFullYear() : null,
              }}
            />
          )}
        </Stack>

        {/* Failure */}
        {story.status === 'failed' && (
          <Alert
            color="red"
            variant="light"
            icon={<IconAlertTriangle size={18} />}
            title="Something went wrong retelling this story"
          >
            <Stack gap="sm" align="flex-start">
              {story.errorMessage && <Text size="sm">{story.errorMessage}</Text>}
              <RetryButton storyId={story.id} />
            </Stack>
          </Alert>
        )}

        {/* What it's about */}
        {story.summary && (
          <Text size="lg" c="slate.7">
            {story.summary}
          </Text>
        )}

        {/* Photos */}
        {photos.length > 0 && (
          <Stack gap="sm">
            <Title order={3}>Photos</Title>
            <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="md">
              {photos.map((p) => (
                <Image
                  key={p.id}
                  src={p.url}
                  alt={p.caption ?? story.title}
                  radius="md"
                  fit="cover"
                  h={200}
                />
              ))}
            </SimpleGrid>
          </Stack>
        )}

        {/* The story */}
        <Stack gap="sm">
          <Title order={3}>The story</Title>
          {styledParas.length > 0 ? (
            <Box maw="68ch">
              <Stack gap="md">
                {styledParas.map((para, i) => (
                  <Text key={i} size="md" style={{ lineHeight: 1.75 }}>
                    {para}
                  </Text>
                ))}
              </Stack>
            </Box>
          ) : story.status === 'processing' ? (
            <Text c="dimmed" fs="italic">
              This story is being retold… check back in a moment.
            </Text>
          ) : story.bodyOriginal ? (
            <Box maw="68ch">
              <Stack gap="md">
                {paragraphs(story.bodyOriginal).map((para, i) => (
                  <Text key={i} size="md" style={{ lineHeight: 1.75 }}>
                    {para}
                  </Text>
                ))}
              </Stack>
            </Box>
          ) : (
            <Text c="dimmed" fs="italic">
              No retold text yet.
            </Text>
          )}
        </Stack>

        {/* Dive deeper */}
        {(story.bodyOriginal || audioUrl || story.conversationId) && (
          <>
            <Divider label="Dive deeper" labelPosition="center" />
            <SourceAccordion
              audioUrl={audioUrl}
              originalParas={story.bodyOriginal ? paragraphs(story.bodyOriginal) : []}
              inputType={story.inputType}
              fromConversation={Boolean(story.conversationId)}
            />
          </>
        )}
      </Stack>
    </Box>
  );
}
