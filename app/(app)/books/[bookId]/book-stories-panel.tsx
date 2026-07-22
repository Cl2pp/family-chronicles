'use client';

import { useState, useTransition } from 'react';
import { ActionIcon, Button, Card, Group, Menu, Stack, Switch, Text, Title, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useRouter } from 'next/navigation';
import { IconArrowDown, IconArrowUp, IconPlus, IconX } from '@tabler/icons-react';
import { useI18n } from '@/lib/i18n/client';
import { setBookStoriesAction, setBookStoryFlagsAction } from '../actions';

export interface BookChapterView {
  storyId: string;
  title: string;
  year: number | null;
  photoCount: number;
  includeText: boolean;
  includePhotos: boolean;
}

export interface ChronicleStoryOption {
  id: string;
  title: string;
  year: number | null;
}

/**
 * The story side of the unified builder's "Inhalte" step (PR D): which stories are in
 * the book, in what order, and what each contributes — its text, its photos, or both.
 *
 * The chapter list and its reorder/remove controls are ported from the retired story
 * builder; the per-chapter switches are new and are what makes "a book from stories"
 * and "a book from uploads" the same thing with different sources. Both toggles off is
 * refused server-side (`setBookStoryFlags`) — that's what removing the chapter is for.
 *
 * Photo counts come from the book's mirrored `book_photos` rows, so this shows what the
 * layout will actually see, not what the story happens to own.
 */
export function BookStoriesPanel({
  bookId,
  chapters,
  chronicleStories,
  locked,
}: {
  bookId: string;
  chapters: BookChapterView[];
  chronicleStories: ChronicleStoryOption[];
  locked: boolean;
}) {
  const { t } = useI18n();
  const ts = t.books.builder.photoBook.sources;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyStory, setBusyStory] = useState<string | null>(null);

  const inBook = new Set(chapters.map((c) => c.storyId));
  const available = chronicleStories.filter((s) => !inBook.has(s.id));

  function replaceStories(storyIds: string[]) {
    startTransition(async () => {
      const result = await setBookStoriesAction({ bookId, storyIds });
      if (result.error) {
        notifications.show({ color: 'red', message: result.error });
        return;
      }
      router.refresh();
    });
  }

  function toggleFlag(storyId: string, patch: { includeText?: boolean; includePhotos?: boolean }) {
    setBusyStory(storyId);
    startTransition(async () => {
      const result = await setBookStoryFlagsAction({ bookId, storyId, ...patch });
      setBusyStory(null);
      if (result.error) {
        notifications.show({ color: 'red', message: result.error });
        return;
      }
      router.refresh();
    });
  }

  const move = (index: number, delta: number) => {
    const ids = chapters.map((c) => c.storyId);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    replaceStories(ids);
  };

  return (
    <Card withBorder radius="md" p="md">
      <Group justify="space-between" mb={4} wrap="wrap">
        <Title order={4}>{ts.storiesTitle}</Title>
        {!locked && available.length > 0 && (
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <Button size="compact-sm" variant="light" leftSection={<IconPlus size={14} />} disabled={pending}>
                {ts.addStory}
              </Button>
            </Menu.Target>
            <Menu.Dropdown mah={320} style={{ overflowY: 'auto' }}>
              {available.map((s) => (
                <Menu.Item
                  key={s.id}
                  onClick={() => replaceStories([...chapters.map((c) => c.storyId), s.id])}
                >
                  {s.title}
                  {s.year ? ` · ${s.year}` : ''}
                </Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>
        )}
      </Group>
      <Text fz={12} c="dimmed" mb="sm">
        {ts.storiesHint}
      </Text>

      {chapters.length === 0 ? (
        <Text fz={13} c="dimmed">
          {ts.noStories}
        </Text>
      ) : (
        <Stack gap={8}>
          {chapters.map((c, i) => (
            <Card key={c.storyId} withBorder radius="sm" p="sm">
              <Group justify="space-between" wrap="nowrap" align="flex-start">
                <Stack gap={2} style={{ minWidth: 0 }}>
                  <Text fz={14} fw={500} lineClamp={1}>
                    {c.title}
                  </Text>
                  <Text fz={11} c="dimmed">
                    {[c.year, ts.photoCount(c.photoCount)].filter(Boolean).join(' · ')}
                  </Text>
                </Stack>
                {!locked && (
                  <Group gap={2} wrap="nowrap">
                    <Tooltip label={ts.moveUp}>
                      <ActionIcon variant="subtle" size="sm" disabled={i === 0 || pending} onClick={() => move(i, -1)}>
                        <IconArrowUp size={14} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label={ts.moveDown}>
                      <ActionIcon
                        variant="subtle"
                        size="sm"
                        disabled={i === chapters.length - 1 || pending}
                        onClick={() => move(i, 1)}
                      >
                        <IconArrowDown size={14} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label={ts.removeStory}>
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        size="sm"
                        disabled={pending}
                        onClick={() =>
                          replaceStories(chapters.filter((x) => x.storyId !== c.storyId).map((x) => x.storyId))
                        }
                      >
                        <IconX size={14} />
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                )}
              </Group>
              <Group gap="lg" mt={8}>
                <Switch
                  size="xs"
                  label={ts.includeText}
                  checked={c.includeText}
                  disabled={locked || pending || busyStory === c.storyId}
                  onChange={(e) => toggleFlag(c.storyId, { includeText: e.currentTarget.checked })}
                />
                <Switch
                  size="xs"
                  label={ts.includePhotos}
                  checked={c.includePhotos}
                  disabled={locked || pending || busyStory === c.storyId || c.photoCount === 0}
                  onChange={(e) => toggleFlag(c.storyId, { includePhotos: e.currentTarget.checked })}
                />
              </Group>
            </Card>
          ))}
        </Stack>
      )}
    </Card>
  );
}
