'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Badge,
  Box,
  Button,
  Card,
  Chip,
  Group,
  Image,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Text,
  Title,
  UnstyledButton,
} from '@mantine/core';
import {
  IconArrowsSort,
  IconBook,
  IconMicrophone,
  IconPhoto,
  IconPlus,
  IconUsers,
} from '@tabler/icons-react';
import { formatEventDate } from '@/lib/dates';
import { storyStatusMeta } from '@/lib/story-status';
import { useI18n } from '@/lib/i18n/client';
import type { StoryListItem } from '@/lib/stories';

type ViewMode = 'timeline' | 'bubbles';

/**
 * Which date the timeline is built on. 'happened' (default) uses the event date —
 * when the story took place — so the memoir reads chronologically. 'added' uses the
 * submission date, for browsing by what's newest.
 */
type SortMode = 'happened' | 'added';

function eventTime(story: StoryListItem): number | null {
  if (!story.eventDate) return null;
  const t = new Date(story.eventDate).getTime();
  return Number.isNaN(t) ? null : t;
}

function createdTime(story: StoryListItem): number {
  return new Date(story.createdAt).getTime();
}

function eventYear(story: StoryListItem): number | null {
  const t = eventTime(story);
  return t === null ? null : new Date(t).getUTCFullYear();
}

function createdYear(story: StoryListItem): number {
  return new Date(createdTime(story)).getUTCFullYear();
}

interface YearGroup {
  /** Numeric year, or null for the Undated bucket. */
  year: number | null;
  label: string;
  stories: StoryListItem[];
}

/**
 * Bucket stories into year groups for the timeline along the chosen date axis.
 *
 * - 'happened': group by event year, oldest first, Undated last; within a year the
 *   stories run in event-date order (submission date breaks ties).
 * - 'added': group by the year each story was added, newest first; within a year the
 *   newest submission comes first. Every story has a submission date, so there is no
 *   Undated bucket here.
 */
function groupStories(
  stories: StoryListItem[],
  sort: SortMode,
  undatedLabel: string,
): YearGroup[] {
  if (sort === 'added') {
    const buckets = new Map<number, StoryListItem[]>();
    for (const s of stories) {
      const y = createdYear(s);
      const arr = buckets.get(y) ?? [];
      arr.push(s);
      buckets.set(y, arr);
    }
    return [...buckets.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([year, group]) => ({
        year,
        label: String(year),
        stories: [...group].sort((a, b) => createdTime(b) - createdTime(a)),
      }));
  }

  const buckets = new Map<number | null, StoryListItem[]>();
  for (const s of stories) {
    const y = eventYear(s);
    const arr = buckets.get(y) ?? [];
    arr.push(s);
    buckets.set(y, arr);
  }
  const dated: YearGroup[] = [...buckets.entries()]
    .filter((e) => e[0] !== null)
    .sort((a, b) => (a[0] as number) - (b[0] as number))
    .map(([year, group]) => ({
      year,
      label: String(year),
      stories: [...group].sort(
        (a, b) => (eventTime(a) as number) - (eventTime(b) as number) || createdTime(a) - createdTime(b),
      ),
    }));

  const undated = buckets.get(null);
  if (undated) {
    dated.push({
      year: null,
      label: undatedLabel,
      stories: [...undated].sort((a, b) => createdTime(b) - createdTime(a)),
    });
  }
  return dated;
}

function StoryCard({ story }: { story: StoryListItem }) {
  const { locale, t } = useI18n();
  const meta = storyStatusMeta(story.status, t);
  const date = formatEventDate(story.eventDate, story.eventDatePrecision, locale);
  const excerpt = (story.summary ?? story.bodyStyled ?? story.bodyOriginal ?? '').slice(0, 160);
  const shared = story.chronicleIds.length > 1;

  return (
    <Card
      component="a"
      href={`/stories/${story.id}`}
      withBorder
      radius="md"
      padding="md"
      bg="white"
    >
      {story.bannerPhotoUrls.length > 0 && (
        <Card.Section mb="sm">
          <Group gap={2} wrap="nowrap">
            {story.bannerPhotoUrls.map((url, i) => (
              <Image
                key={url}
                src={url}
                alt={i === 0 ? story.title : ''}
                h={120}
                fit="cover"
                style={{ flex: 1, minWidth: 0 }}
              />
            ))}
          </Group>
        </Card.Section>
      )}
      <Stack gap={6}>
        <Group justify="space-between" align="flex-start" wrap="nowrap" gap="sm">
          <Text fw={600} lineClamp={2} style={{ flex: 1 }}>
            {story.title}
          </Text>
          <Badge variant="light" color={meta.color}>
            {meta.label}
          </Badge>
        </Group>

        <Group gap="xs" c="dimmed">
          <Text size="sm" c="dimmed">
            {t.stories.by(story.submitterName)}
            {date ? ` · ${date}` : ''}
          </Text>
          {story.inputType === 'voice' && <IconMicrophone size={15} />}
          {story.photoCount > 0 && (
            <Group gap={2} wrap="nowrap">
              <IconPhoto size={15} />
              <Text size="xs" c="dimmed">
                {story.photoCount}
              </Text>
            </Group>
          )}
          {shared && (
            <Group gap={2} wrap="nowrap">
              <IconUsers size={15} />
              <Text size="xs" c="dimmed">
                {story.chronicleIds.length}
              </Text>
            </Group>
          )}
        </Group>

        {excerpt && (
          <Text size="sm" c="dimmed" lineClamp={2}>
            {excerpt}
          </Text>
        )}

        {story.familyTags.length > 0 && (
          <Group gap={6} mt={2}>
            {story.familyTags.map((tag) => (
              <Badge key={tag} variant="light" color="slate" size="sm" radius="sm">
                {tag}
              </Badge>
            ))}
          </Group>
        )}
      </Stack>
    </Card>
  );
}

function Timeline({ groups }: { groups: YearGroup[] }) {
  const { t } = useI18n();
  return (
    <Stack gap="xl">
      {groups.map((group) => (
        <Box key={group.label}>
          <Group gap="sm" mb="sm" align="center">
            <Title order={3} c={group.year === null ? 'dimmed' : undefined}>
              {group.label}
            </Title>
            <Text size="sm" c="dimmed">
              {t.stories.storyCount(group.stories.length)}
            </Text>
          </Group>
          <Box
            pl="lg"
            style={{ borderLeft: '2px solid var(--mantine-color-brand-2)' }}
          >
            <Stack gap="md">
              {group.stories.map((story) => (
                <StoryCard key={story.id} story={story} />
              ))}
            </Stack>
          </Box>
        </Box>
      ))}
    </Stack>
  );
}

function YearBubble({
  label,
  count,
  active,
  onSelect,
}: {
  label: string;
  count: number;
  active: boolean;
  onSelect: () => void;
}) {
  // Scale diameter by count, clamped to a friendly range.
  const size = Math.min(132, 60 + count * 12);
  return (
    <UnstyledButton onClick={onSelect}>
      <Stack gap={6} align="center">
        <Box
          style={{
            width: size,
            height: size,
            borderRadius: '50%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: active
              ? 'var(--mantine-color-brand-6)'
              : 'var(--mantine-color-brand-1)',
            border: active
              ? '2px solid var(--mantine-color-brand-7)'
              : '2px solid var(--mantine-color-brand-2)',
            color: active ? 'var(--mantine-color-white)' : 'var(--mantine-color-brand-8)',
            transition: 'background-color 120ms ease',
          }}
        >
          <Text fw={700} style={{ fontSize: size > 90 ? 20 : 16 }}>
            {label}
          </Text>
          <Text size="xs" style={{ opacity: 0.85 }}>
            {count}
          </Text>
        </Box>
      </Stack>
    </UnstyledButton>
  );
}

function Bubbles({ groups }: { groups: YearGroup[] }) {
  const [selected, setSelected] = useState<string>(groups[0]?.label ?? '');
  const current = groups.find((g) => g.label === selected) ?? groups[0];

  return (
    <Stack gap="xl">
      <Group gap="lg" justify="center" align="flex-end" wrap="wrap">
        {groups.map((group) => (
          <YearBubble
            key={group.label}
            label={group.label}
            count={group.stories.length}
            active={current?.label === group.label}
            onSelect={() => setSelected(group.label)}
          />
        ))}
      </Group>

      {current && (
        <Box>
          <Title order={3} mb="sm" c={current.year === null ? 'dimmed' : undefined}>
            {current.label}
          </Title>
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
            {current.stories.map((story) => (
              <StoryCard key={story.id} story={story} />
            ))}
          </SimpleGrid>
        </Box>
      )}
    </Stack>
  );
}

/** Sentinel filter value for stories with no tagged people (so no derived family). */
const NO_FAMILY = '__no-family__';

export function StoriesView({ stories }: { stories: StoryListItem[] }) {
  const { t } = useI18n();
  const [view, setView] = useState<ViewMode>('timeline');
  const [sort, setSort] = useState<SortMode>('happened');
  const [tags, setTags] = useState<string[]>([]);

  // Family tags that actually appear on stories — the ones worth offering as filters.
  // Tags are derived from the people in each story, never configured.
  const tagOptions = useMemo(() => {
    const all = new Set<string>();
    for (const s of stories) for (const tag of s.familyTags) all.add(tag);
    return [...all].sort((a, b) => a.localeCompare(b));
  }, [stories]);

  // Untagged stories would silently vanish under any family selection — give them
  // their own explicit bucket instead.
  const hasUntagged = useMemo(() => stories.some((s) => s.familyTags.length === 0), [stories]);

  // No filter selected → show all; otherwise keep stories carrying any selected tag
  // (the "no family" bucket keeps the untagged ones).
  const visible = useMemo(
    () =>
      tags.length === 0
        ? stories
        : stories.filter(
            (s) =>
              s.familyTags.some((tag) => tags.includes(tag)) ||
              (tags.includes(NO_FAMILY) && s.familyTags.length === 0),
          ),
    [stories, tags],
  );

  const groups = useMemo(
    () => groupStories(visible, sort, t.stories.undated),
    [visible, sort, t.stories.undated],
  );

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="center" wrap="wrap" gap="sm">
        <Title order={1}>{t.stories.title}</Title>
        <Group gap="sm" wrap="wrap">
          <Button
            component={Link}
            href="/books"
            size="xs"
            variant="light"
            leftSection={<IconBook size={14} />}
          >
            {t.books.createFromStories}
          </Button>
          <Button
            component={Link}
            href="/chat?intent=add-story"
            size="xs"
            leftSection={<IconPlus size={14} />}
          >
            {t.stories.addStory}
          </Button>
        </Group>
      </Group>

      <Group justify="space-between" align="center" wrap="wrap" gap="sm">
        <Select
          size="xs"
          w={210}
          aria-label={t.stories.sortLabel}
          leftSection={<IconArrowsSort size={14} />}
          value={sort}
          onChange={(v) => v && setSort(v as SortMode)}
          allowDeselect={false}
          comboboxProps={{ withinPortal: true }}
          data={[
            { label: t.stories.sortHappened, value: 'happened' },
            { label: t.stories.sortAdded, value: 'added' },
          ]}
        />
        <SegmentedControl
          size="xs"
          value={view}
          onChange={(v) => setView(v as ViewMode)}
          data={[
            { label: t.stories.viewTimeline, value: 'timeline' },
            { label: t.stories.viewBubbles, value: 'bubbles' },
          ]}
        />
      </Group>

      {(tagOptions.length > 1 || (tagOptions.length > 0 && hasUntagged)) && (
        <Group gap="xs" align="center">
          <Text size="sm" c="dimmed">
            {t.stories.show}
          </Text>
          <Chip size="sm" variant="light" checked={tags.length === 0} onClick={() => setTags([])}>
            {t.stories.allFamilies}
          </Chip>
          <Chip.Group multiple value={tags} onChange={setTags}>
            <Group gap="xs">
              {tagOptions.map((tag) => (
                <Chip key={tag} value={tag} size="sm" variant="light">
                  {tag}
                </Chip>
              ))}
              {hasUntagged && (
                <Chip value={NO_FAMILY} size="sm" variant="light">
                  {t.stories.noFamily}
                </Chip>
              )}
            </Group>
          </Chip.Group>
        </Group>
      )}

      {visible.length === 0 ? (
        <Card withBorder radius="md" p="xl">
          <Text c="dimmed" ta="center">
            {t.stories.noneInFamilies}
          </Text>
        </Card>
      ) : view === 'timeline' ? (
        <Timeline groups={groups} />
      ) : (
        <Bubbles groups={groups} />
      )}
    </Stack>
  );
}
