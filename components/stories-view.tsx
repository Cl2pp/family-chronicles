'use client';

import { useMemo, useState } from 'react';
import {
  Accordion,
  Badge,
  Card,
  Group,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core';
import { IconMicrophone, IconPhoto, IconLink } from '@tabler/icons-react';
import { formatEventDate } from '@/lib/dates';
import { storyStatusMeta, type StoryStatus } from '@/lib/story-status';
import type { DatePrecision } from '@/lib/stories';

interface Story {
  id: string;
  title: string;
  status: StoryStatus;
  inputType: 'text' | 'voice';
  bodyStyled: string | null;
  bodyOriginal: string | null;
  eventDate: Date | string | null;
  eventDatePrecision: DatePrecision | null;
  eventId: string | null;
  submitterName: string;
}

const UNDATED = 'undated';

function yearOf(date: Date | string): number {
  return new Date(date).getUTCFullYear();
}

function StoryCard({
  chronicleId,
  story,
  photoCount,
}: {
  chronicleId: string;
  story: Story;
  photoCount: number;
}) {
  const meta = storyStatusMeta(story.status);
  const date = formatEventDate(story.eventDate, story.eventDatePrecision);
  const excerpt = (story.bodyStyled ?? story.bodyOriginal ?? '').slice(0, 160);

  return (
    <Card
      component="a"
      href={`/chronicles/${chronicleId}/stories/${story.id}`}
      withBorder
      radius="md"
      padding="md"
    >
      <Group justify="space-between" align="flex-start" mb={4}>
        <Text fw={600}>{story.title}</Text>
        <Badge variant="light" color={meta.color}>
          {meta.label}
        </Badge>
      </Group>
      <Group gap={6} mb={excerpt ? 6 : 0}>
        <Text size="xs" c="dimmed">
          By {story.submitterName}
          {date ? ` · ${date}` : ''}
        </Text>
        {story.inputType === 'voice' ? <IconMicrophone size={13} color="gray" /> : null}
        {photoCount > 0 ? (
          <Group gap={2}>
            <IconPhoto size={13} color="gray" />
            <Text size="xs" c="dimmed">
              {photoCount}
            </Text>
          </Group>
        ) : null}
        {story.eventId ? <IconLink size={13} color="gray" /> : null}
      </Group>
      {excerpt ? (
        <Text size="sm" c="dimmed" lineClamp={2}>
          {excerpt}
        </Text>
      ) : null}
    </Card>
  );
}

export function StoriesView({
  chronicleId,
  stories,
  photoCounts,
}: {
  chronicleId: string;
  stories: Story[];
  photoCounts: Record<string, number>;
}) {
  const [view, setView] = useState<'list' | 'timeline' | 'bubbles'>('list');

  // Group dated stories by year (ascending); collect undated separately.
  const { years, byYear, undated } = useMemo(() => {
    const dated = stories.filter((s) => s.eventDate && s.eventDatePrecision);
    const undatedStories = stories.filter((s) => !s.eventDate || !s.eventDatePrecision);
    const map = new Map<number, Story[]>();
    for (const s of dated) {
      const y = yearOf(s.eventDate as Date | string);
      const arr = map.get(y) ?? [];
      arr.push(s);
      map.set(y, arr);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => new Date(a.eventDate!).getTime() - new Date(b.eventDate!).getTime());
    }
    const sortedYears = [...map.keys()].sort((a, b) => a - b);
    return { years: sortedYears, byYear: map, undated: undatedStories };
  }, [stories]);

  function card(s: Story) {
    return (
      <StoryCard
        key={s.id}
        chronicleId={chronicleId}
        story={s}
        photoCount={photoCounts[s.id] ?? 0}
      />
    );
  }

  return (
    <Stack>
      <SegmentedControl
        value={view}
        onChange={(v) => setView(v as typeof view)}
        data={[
          { value: 'list', label: 'List' },
          { value: 'timeline', label: 'Timeline' },
          { value: 'bubbles', label: 'Bubbles' },
        ]}
        w="fit-content"
      />

      {view === 'list' && <Stack gap="sm">{stories.map(card)}</Stack>}

      {view === 'timeline' && (
        <TimelineView
          years={years}
          byYear={byYear}
          undated={undated}
          renderCard={card}
        />
      )}

      {view === 'bubbles' && (
        <BubbleView years={years} byYear={byYear} undated={undated} renderCard={card} />
      )}
    </Stack>
  );
}

function TimelineView({
  years,
  byYear,
  undated,
  renderCard,
}: {
  years: number[];
  byYear: Map<number, Story[]>;
  undated: Story[];
  renderCard: (s: Story) => React.ReactNode;
}) {
  const defaultOpen = [...years.map(String), ...(undated.length ? [UNDATED] : [])];

  if (years.length === 0 && undated.length === 0) {
    return <Text c="dimmed">No stories yet.</Text>;
  }

  return (
    <Accordion multiple defaultValue={defaultOpen} variant="separated">
      {years.map((y) => {
        const items = byYear.get(y)!;
        return (
          <Accordion.Item key={y} value={String(y)}>
            <Accordion.Control>
              <Group justify="space-between" pr="md">
                <Text fw={600}>{y}</Text>
                <Text size="sm" c="dimmed">
                  {items.length} {items.length === 1 ? 'story' : 'stories'}
                </Text>
              </Group>
            </Accordion.Control>
            <Accordion.Panel>
              <Stack gap="sm">{items.map(renderCard)}</Stack>
            </Accordion.Panel>
          </Accordion.Item>
        );
      })}

      {undated.length > 0 && (
        <Accordion.Item value={UNDATED}>
          <Accordion.Control>
            <Group justify="space-between" pr="md">
              <Text fw={600}>Undated</Text>
              <Text size="sm" c="dimmed">
                {undated.length} {undated.length === 1 ? 'story' : 'stories'}
              </Text>
            </Group>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap="sm">{undated.map(renderCard)}</Stack>
          </Accordion.Panel>
        </Accordion.Item>
      )}
    </Accordion>
  );
}

function BubbleView({
  years,
  byYear,
  undated,
  renderCard,
}: {
  years: number[];
  byYear: Map<number, Story[]>;
  undated: Story[];
  renderCard: (s: Story) => React.ReactNode;
}) {
  const bubbles = [
    ...years.map((y) => ({ key: String(y), label: String(y), count: byYear.get(y)!.length })),
    ...(undated.length ? [{ key: UNDATED, label: 'Undated', count: undated.length }] : []),
  ];

  const [selected, setSelected] = useState<string>(bubbles.at(-1)?.key ?? '');

  if (bubbles.length === 0) {
    return <Text c="dimmed">No stories yet.</Text>;
  }

  const selectedStories = selected === UNDATED ? undated : byYear.get(Number(selected)) ?? [];

  return (
    <Stack>
      <Group gap="sm" wrap="wrap">
        {bubbles.map((b) => {
          const size = 48 + Math.min(b.count * 8, 40);
          const isSel = b.key === selected;
          return (
            <UnstyledButton
              key={b.key}
              onClick={() => setSelected(b.key)}
              style={{
                width: size,
                height: size,
                borderRadius: '50%',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                background: isSel ? 'var(--mantine-color-sienna-6)' : 'var(--mantine-color-sienna-1)',
                color: isSel ? 'white' : 'var(--mantine-color-sienna-9)',
                border: '1px solid var(--mantine-color-sienna-3)',
                transition: 'background 120ms',
              }}
            >
              <Text fw={600} fz={b.key === UNDATED ? 'xs' : 'sm'} style={{ lineHeight: 1.1 }}>
                {b.label}
              </Text>
              <Text fz={10} style={{ opacity: 0.8 }}>
                {b.count}
              </Text>
            </UnstyledButton>
          );
        })}
      </Group>

      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
        {selectedStories.map(renderCard)}
      </SimpleGrid>
    </Stack>
  );
}
