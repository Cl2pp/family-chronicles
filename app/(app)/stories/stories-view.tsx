'use client';

import { useMemo, useState } from 'react';
import {
  Badge,
  Box,
  Card,
  Chip,
  Group,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { IconMicrophone, IconPhoto, IconUsers } from '@tabler/icons-react';
import { formatEventDate } from '@/lib/dates';
import { storyStatusMeta } from '@/lib/story-status';
import type { StoryListItem } from '@/lib/stories';

type ViewMode = 'timeline' | 'bubbles';

const UNDATED = 'Undated';

function yearKey(story: StoryListItem): number | null {
  if (!story.eventDate) return null;
  const d = new Date(story.eventDate);
  return Number.isNaN(d.getTime()) ? null : d.getUTCFullYear();
}

interface YearGroup {
  /** Numeric year, or null for the Undated bucket. */
  year: number | null;
  label: string;
  stories: StoryListItem[];
}

/** Group stories by event-year, ascending, with Undated last. */
function groupByYear(stories: StoryListItem[]): YearGroup[] {
  const buckets = new Map<number | null, StoryListItem[]>();
  for (const s of stories) {
    const y = yearKey(s);
    const arr = buckets.get(y) ?? [];
    arr.push(s);
    buckets.set(y, arr);
  }
  const dated: YearGroup[] = [...buckets.entries()]
    .filter((e) => e[0] !== null)
    .sort((a, b) => (a[0] as number) - (b[0] as number))
    .map(([year, group]) => ({ year, label: String(year), stories: group }));

  const undated = buckets.get(null);
  if (undated) dated.push({ year: null, label: UNDATED, stories: undated });
  return dated;
}

function StoryCard({ story }: { story: StoryListItem }) {
  const meta = storyStatusMeta(story.status);
  const date = formatEventDate(story.eventDate, story.eventDatePrecision);
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
            By {story.submitterName}
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
  return (
    <Stack gap="xl">
      {groups.map((group) => (
        <Box key={group.label}>
          <Group gap="sm" mb="sm" align="center">
            <Title order={3} c={group.year === null ? 'dimmed' : undefined}>
              {group.label}
            </Title>
            <Text size="sm" c="dimmed">
              {group.stories.length} {group.stories.length === 1 ? 'story' : 'stories'}
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

export function StoriesView({ stories }: { stories: StoryListItem[] }) {
  const [view, setView] = useState<ViewMode>('timeline');
  const [tags, setTags] = useState<string[]>([]);

  // Family tags that actually appear on stories — the ones worth offering as filters.
  // Tags are derived from the people in each story, never configured.
  const tagOptions = useMemo(() => {
    const all = new Set<string>();
    for (const s of stories) for (const tag of s.familyTags) all.add(tag);
    return [...all].sort((a, b) => a.localeCompare(b));
  }, [stories]);

  // No filter selected → show all; otherwise keep stories carrying any selected tag.
  const visible = useMemo(
    () =>
      tags.length === 0
        ? stories
        : stories.filter((s) => s.familyTags.some((tag) => tags.includes(tag))),
    [stories, tags],
  );

  const groups = useMemo(() => groupByYear(visible), [visible]);

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="center">
        <Title order={1}>Stories</Title>
        <SegmentedControl
          value={view}
          onChange={(v) => setView(v as ViewMode)}
          data={[
            { label: 'Timeline', value: 'timeline' },
            { label: 'Bubbles', value: 'bubbles' },
          ]}
        />
      </Group>

      {tagOptions.length > 1 && (
        <Group gap="xs" align="center">
          <Text size="sm" c="dimmed">
            Show:
          </Text>
          <Chip size="sm" variant="light" checked={tags.length === 0} onClick={() => setTags([])}>
            All families
          </Chip>
          <Chip.Group multiple value={tags} onChange={setTags}>
            <Group gap="xs">
              {tagOptions.map((tag) => (
                <Chip key={tag} value={tag} size="sm" variant="light">
                  {tag}
                </Chip>
              ))}
            </Group>
          </Chip.Group>
        </Group>
      )}

      {visible.length === 0 ? (
        <Card withBorder radius="md" p="xl">
          <Text c="dimmed" ta="center">
            No stories in the selected families.
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
