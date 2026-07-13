import { notFound } from 'next/navigation';
import { Alert, Badge, Box, Button, Divider, Group, Stack, Text, Title } from '@mantine/core';
import { IconAlertTriangle, IconArrowLeft } from '@tabler/icons-react';
import { requireUser } from '@/lib/session';
import {
  canUserEditStory,
  chroniclesForStory,
  getStoryForUser,
  listAssets,
  listContributions,
} from '@/lib/stories';
import { familyTagsByStory } from '@/lib/family-tags';
import { listChroniclesForUser } from '@/lib/chronicles';
import { eventDateToParts, formatEventDate, formatFullDate } from '@/lib/dates';
import { storyStatusMeta } from '@/lib/story-status';
import { getI18n } from '@/lib/i18n/server';
import { presignGet } from '@/lib/s3';
import { CollapsibleSection } from '@/components/collapsible-section';
import { RetryButton } from './retry-button';
import { SourceTimeline, type ContributionView } from './source-timeline';
import { ShareControl } from './share-control';
import { EditControl } from './edit-control';
import { AddPhotosControl } from './add-photos-control';
import { PhotoGallery } from './photo-gallery';

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
  const { locale, t } = await getI18n();
  const story = await getStoryForUser(storyId, user.id);
  if (!story) notFound();

  const [shareChronicles, assets, userChronicles, canEdit, tagsByStory, contributions] =
    await Promise.all([
      chroniclesForStory(storyId),
      listAssets(storyId),
      listChroniclesForUser(user.id),
      canUserEditStory(storyId, user.id),
      familyTagsByStory([storyId]),
      listContributions(storyId),
    ]);
  const familyTags = tagsByStory.get(storyId) ?? [];

  const sharedIds = new Set(shareChronicles.map((f) => f.id));
  const shareCandidates = userChronicles
    .filter((f) => !sharedIds.has(f.id))
    .map((f) => ({ id: f.id, name: f.name }));

  const photoAssets = assets.filter((a) => a.kind === 'photo');
  const audioAssets = assets.filter((a) => a.kind === 'audio');

  const presigned = new Map(
    await Promise.all(
      assets.map(async (a) => [a.id, await presignGet(a.s3Key, a.mimeType)] as const),
    ),
  );
  const photos = photoAssets.map((a) => ({
    id: a.id,
    url: presigned.get(a.id)!,
    caption: a.caption,
    width: a.width,
    height: a.height,
  }));

  /**
   * Group assets under their contribution for the source timeline. Assets that predate
   * the contributions table (or were claimed before backfill) fall back to the newest
   * contribution that isn't younger than they are — that's the save that brought them.
   */
  function contributionIdFor(asset: (typeof assets)[number]): string | null {
    if (asset.contributionId) return asset.contributionId;
    if (contributions.length === 0) return null;
    const notYounger = contributions.filter(
      (c) => c.createdAt.getTime() <= asset.createdAt.getTime() + 60_000,
    );
    return (notYounger[notYounger.length - 1] ?? contributions[0]).id;
  }

  const contributionViews: ContributionView[] = contributions.map((c) => ({
    id: c.id,
    contributorName: c.contributorName,
    createdAt: c.createdAt.toISOString(),
    text: c.text,
    audio: audioAssets
      .filter((a) => contributionIdFor(a) === c.id)
      .map((a) => ({ id: a.id, url: presigned.get(a.id)!, durationSec: a.durationSec })),
    photos: photoAssets
      .filter((a) => contributionIdFor(a) === c.id)
      .map((a) => ({ id: a.id, url: presigned.get(a.id)!, caption: a.caption })),
  }));

  // Stories from before the contributions table (not yet backfilled) still get the
  // timeline: their whole source is one entry by the submitter, dated to the story.
  if (contributionViews.length === 0 && (story.bodyOriginal || audioAssets.length > 0)) {
    contributionViews.push({
      id: 'legacy',
      contributorName: story.submitterName,
      createdAt: story.createdAt.toISOString(),
      text: story.bodyOriginal,
      audio: audioAssets.map((a) => ({
        id: a.id,
        url: presigned.get(a.id)!,
        durationSec: a.durationSec,
      })),
      photos: [],
    });
  }

  const meta = storyStatusMeta(story.status, t);
  const date = formatEventDate(story.eventDate, story.eventDatePrecision, locale);
  const styledParas = story.bodyStyled ? paragraphs(story.bodyStyled) : [];

  return (
    <Box p="lg" maw={960} mx="auto">
      <Stack gap="xl">
        {/* Header */}
        <Stack gap="sm">
          <Group>
            {/* Plain <a>: an RSC can't pass the Link component into Mantine's polymorphic prop. */}
            <Button
              component="a"
              href="/stories"
              size="compact-sm"
              variant="subtle"
              color="gray"
              leftSection={<IconArrowLeft size={16} />}
            >
              {t.story.backToStories}
            </Button>
          </Group>
          <Group justify="space-between" align="flex-start" wrap="nowrap">
            <Title order={1}>{story.title}</Title>
            <Badge variant="light" color={meta.color} size="lg">
              {meta.label}
            </Badge>
          </Group>
          <Text c="dimmed">
            {t.stories.by(story.submitterName)}
            {date ? ` · ${date}` : ''}
          </Text>
          <Text size="sm" c="dimmed" mt={-8}>
            {t.story.recordedOn(formatFullDate(story.createdAt, locale))}
          </Text>
          {familyTags.length > 0 && (
            <Group gap="xs" align="center">
              <Text size="sm" c="dimmed">
                {t.story.families}
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
                {t.story.sharedWith}
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
                eventDate: eventDateToParts(story.eventDate, story.eventDatePrecision),
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
            title={t.story.failedTitle}
          >
            <Stack gap="sm" align="flex-start">
              {story.errorMessage && <Text size="sm">{story.errorMessage}</Text>}
              <RetryButton storyId={story.id} />
            </Stack>
          </Alert>
        )}

        {/* Photos — the story's visual banner, right at the top */}
        {(photos.length > 0 || canEdit) && (
          <CollapsibleSection
            title={t.story.photos}
            action={canEdit ? <AddPhotosControl storyId={story.id} /> : undefined}
          >
            {photos.length > 0 && (
              <PhotoGallery
                storyId={story.id}
                photos={photos}
                canEdit={canEdit}
                storyTitle={story.title}
                initialVisible={3}
              />
            )}
          </CollapsibleSection>
        )}

        {/* What it's about */}
        {story.summary && (
          <Text size="lg" c="slate.7">
            {story.summary}
          </Text>
        )}

        {/* The story */}
        <CollapsibleSection title={t.story.theStory}>
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
              {t.story.beingRetold}
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
              {t.story.noRetoldText}
            </Text>
          )}
        </CollapsibleSection>

        {/* Source material */}
        {contributionViews.length > 0 && (
          <>
            <Divider label={t.story.diveDeeper} labelPosition="center" />
            <CollapsibleSection title={t.story.sourceMaterial}>
              <SourceTimeline
                contributions={contributionViews}
                fromConversation={Boolean(story.conversationId)}
              />
            </CollapsibleSection>
          </>
        )}
      </Stack>
    </Box>
  );
}
