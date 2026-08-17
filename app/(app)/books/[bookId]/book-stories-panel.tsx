'use client';

import { useOptimistic, useState, useTransition } from 'react';
import { ActionIcon, Button, Card, Group, Menu, Stack, Switch, Text, Title, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useRouter } from 'next/navigation';
import { IconGripVertical, IconPlus, IconX } from '@tabler/icons-react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
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
 * Chapters are reordered by drag-and-drop (grip handle; pointer, touch and keyboard via
 * dnd-kit). The order is applied optimistically so the dropped card stays put while the
 * server round-trip + refresh run. The per-chapter switches are what makes "a book from
 * stories" and "a book from uploads" the same thing with different sources. Both toggles
 * off is refused server-side (`setBookStoryFlags`) — that's what removing the chapter is
 * for.
 *
 * Photo counts come from the book's mirrored `book_photos` rows, so this shows what the
 * layout will actually see, not what the story happens to own.
 */
export function BookStoriesPanel({
  bookId,
  chapters,
  chronicleStories,
  locked,
  hiddenChapterCount,
}: {
  bookId: string;
  chapters: BookChapterView[];
  chronicleStories: ChronicleStoryOption[];
  locked: boolean;
  /** Chapters this viewer can't read. `setBookStories` refuses a full replace from such
   *  a partial view (it would silently drop the invisible chapters), so the controls are
   *  disabled and the reason is stated up front rather than surfaced as an error after
   *  the click. */
  hiddenChapterCount: number;
}) {
  const { t } = useI18n();
  const ts = t.books.builder.photoBook.sources;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyStory, setBusyStory] = useState<string | null>(null);
  // Chapter order as shown; diverges from `chapters` only while a reorder is in flight.
  const [orderedChapters, setOptimisticOrder] = useOptimistic(chapters);

  const partialView = hiddenChapterCount > 0;
  const readOnly = locked || partialView;
  const inBook = new Set(chapters.map((c) => c.storyId));
  const available = chronicleStories.filter((s) => !inBook.has(s.id));

  const sensors = useSensors(
    // A small activation distance keeps taps on the switches/buttons from starting a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function replaceStories(storyIds: string[], optimistic?: BookChapterView[]) {
    startTransition(async () => {
      if (optimistic) setOptimisticOrder(optimistic);
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

  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    const from = orderedChapters.findIndex((c) => c.storyId === active.id);
    const to = orderedChapters.findIndex((c) => c.storyId === over.id);
    if (from < 0 || to < 0) return;
    const next = arrayMove(orderedChapters, from, to);
    replaceStories(
      next.map((c) => c.storyId),
      next,
    );
  }

  return (
    <Card withBorder radius="md" p="md">
      <Group justify="space-between" mb={4} wrap="wrap">
        <Title order={4}>{ts.storiesTitle}</Title>
        {!readOnly && available.length > 0 && (
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
      {partialView && (
        <Text fz={12} c="orange.7" mb="sm">
          {t.books.builder.hiddenChapters(hiddenChapterCount)}
        </Text>
      )}

      {orderedChapters.length === 0 ? (
        <Text fz={13} c="dimmed">
          {ts.noStories}
        </Text>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis]}
          onDragEnd={onDragEnd}
        >
          <SortableContext items={orderedChapters.map((c) => c.storyId)} strategy={verticalListSortingStrategy}>
            <Stack gap={8}>
              {orderedChapters.map((c) => (
                <SortableChapterCard
                  key={c.storyId}
                  chapter={c}
                  readOnly={readOnly}
                  pending={pending}
                  busy={busyStory === c.storyId}
                  labels={ts}
                  onRemove={() =>
                    replaceStories(chapters.filter((x) => x.storyId !== c.storyId).map((x) => x.storyId))
                  }
                  onToggle={(patch) => toggleFlag(c.storyId, patch)}
                />
              ))}
            </Stack>
          </SortableContext>
        </DndContext>
      )}
    </Card>
  );
}

function SortableChapterCard({
  chapter: c,
  readOnly,
  pending,
  busy,
  labels: ts,
  onRemove,
  onToggle,
}: {
  chapter: BookChapterView;
  readOnly: boolean;
  pending: boolean;
  busy: boolean;
  labels: ReturnType<typeof useI18n>['t']['books']['builder']['photoBook']['sources'];
  onRemove: () => void;
  onToggle: (patch: { includeText?: boolean; includePhotos?: boolean }) => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: c.storyId,
    disabled: readOnly || pending,
  });

  return (
    <Card
      ref={setNodeRef}
      withBorder
      radius="sm"
      p="sm"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        position: 'relative',
        zIndex: isDragging ? 1 : undefined,
        boxShadow: isDragging ? 'var(--mantine-shadow-md)' : undefined,
        opacity: isDragging ? 0.9 : undefined,
      }}
    >
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <Group gap={6} wrap="nowrap" align="flex-start" style={{ minWidth: 0 }}>
          {!readOnly && (
            <Tooltip label={ts.dragToReorder}>
              <ActionIcon
                ref={setActivatorNodeRef}
                variant="subtle"
                color="gray"
                size="sm"
                disabled={pending}
                aria-label={ts.dragToReorder}
                style={{ cursor: isDragging ? 'grabbing' : 'grab', touchAction: 'none', flexShrink: 0 }}
                {...attributes}
                {...listeners}
              >
                <IconGripVertical size={14} />
              </ActionIcon>
            </Tooltip>
          )}
          <Stack gap={2} style={{ minWidth: 0 }}>
            <Text fz={14} fw={500} lineClamp={1}>
              {c.title}
            </Text>
            <Text fz={11} c="dimmed">
              {[c.year, ts.photoCount(c.photoCount)].filter(Boolean).join(' · ')}
            </Text>
          </Stack>
        </Group>
        {!readOnly && (
          <Tooltip label={ts.removeStory}>
            <ActionIcon variant="subtle" color="red" size="sm" disabled={pending} onClick={onRemove}>
              <IconX size={14} />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>
      <Group gap="lg" mt={8}>
        <Switch
          size="xs"
          label={ts.includeText}
          checked={c.includeText}
          disabled={readOnly || pending || busy}
          onChange={(e) => onToggle({ includeText: e.currentTarget.checked })}
        />
        <Switch
          size="xs"
          label={ts.includePhotos}
          checked={c.includePhotos}
          disabled={readOnly || pending || busy || c.photoCount === 0}
          onChange={(e) => onToggle({ includePhotos: e.currentTarget.checked })}
        />
      </Group>
    </Card>
  );
}
