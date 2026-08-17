'use client';

import { useId, useOptimistic, useState, useTransition } from 'react';
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
  type Announcements,
  type DragEndEvent,
} from '@dnd-kit/core';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
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
 * dnd-kit). Every list change (reorder, add, remove) is applied optimistically so the
 * card lands where the user put it while the server round-trip + refresh run; on error
 * the optimistic list falls back to `chapters`. The per-chapter switches are what makes "a book from
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
  // The list as shown; diverges from `chapters` only while a list change is in flight.
  const [shownChapters, setOptimisticChapters] = useOptimistic(chapters);
  // Stable id so dnd-kit's aria ids match between server and client render.
  const dndId = useId();

  const partialView = hiddenChapterCount > 0;
  const readOnly = locked || partialView;
  const inBook = new Set(shownChapters.map((c) => c.storyId));
  const available = chronicleStories.filter((s) => !inBook.has(s.id));

  const sensors = useSensors(
    // A small activation distance keeps taps on the switches/buttons from starting a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Localized screen-reader feedback; dnd-kit's defaults are English-only.
  const positionOf = (id: string | number) => shownChapters.findIndex((c) => c.storyId === id);
  const titleOf = (id: string | number) => shownChapters.find((c) => c.storyId === id)?.title ?? '';
  const total = shownChapters.length;
  const announcements: Announcements = {
    onDragStart: ({ active }) => ts.dragPickedUp(titleOf(active.id), positionOf(active.id) + 1, total),
    onDragOver: ({ active, over }) =>
      over ? ts.dragMovedTo(titleOf(active.id), positionOf(over.id) + 1, total) : undefined,
    onDragEnd: ({ active, over }) =>
      over ? ts.dragDropped(titleOf(active.id), positionOf(over.id) + 1, total) : ts.dragCancelled(titleOf(active.id)),
    onDragCancel: ({ active }) => ts.dragCancelled(titleOf(active.id)),
  };
  const accessibility = { announcements, screenReaderInstructions: { draggable: ts.dragInstructions } };

  /** Replace the book's chapter list; `next` is shown immediately and confirmed by the refresh. */
  function replaceStories(next: BookChapterView[]) {
    startTransition(async () => {
      setOptimisticChapters(next);
      const result = await setBookStoriesAction({ bookId, storyIds: next.map((c) => c.storyId) });
      if (result.error) {
        notifications.show({ color: 'red', message: result.error });
        return;
      }
      // The order lives here, the setting it changed lives on the next step — say so.
      if (result.switchedToCustom) {
        notifications.show({ color: 'blue', message: ts.switchedToCustom });
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
    const from = positionOf(active.id);
    const to = positionOf(over.id);
    if (from < 0 || to < 0) return;
    replaceStories(arrayMove(shownChapters, from, to));
  }

  function addStory(s: ChronicleStoryOption) {
    // Photo count and flags are placeholders until the refresh brings the real row
    // (new chapters default to text + photos on, see `setBookStories`).
    replaceStories([
      ...shownChapters,
      { storyId: s.id, title: s.title, year: s.year, photoCount: 0, includeText: true, includePhotos: true },
    ]);
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
                <Menu.Item key={s.id} onClick={() => addStory(s)}>
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

      {shownChapters.length === 0 ? (
        <Text fz={13} c="dimmed">
          {ts.noStories}
        </Text>
      ) : (
        <DndContext
          id={dndId}
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis]}
          accessibility={accessibility}
          onDragEnd={onDragEnd}
        >
          <SortableContext items={shownChapters.map((c) => c.storyId)} strategy={verticalListSortingStrategy}>
            <Stack gap={8}>
              {shownChapters.map((c) => (
                <SortableChapterCard
                  key={c.storyId}
                  chapter={c}
                  readOnly={readOnly}
                  pending={pending}
                  busy={busyStory === c.storyId}
                  labels={ts}
                  onRemove={() => replaceStories(shownChapters.filter((x) => x.storyId !== c.storyId))}
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
              {/* Not `disabled` while pending: `useSortable({disabled})` already blocks a new
                  drag, and a disabled button can't keep focus for keyboard users after a drop.
                  `md` for a usable touch target — dragging is the only way to reorder. */}
              <ActionIcon
                ref={setActivatorNodeRef}
                variant="subtle"
                color="gray"
                size="md"
                aria-label={ts.dragToReorder}
                style={{ cursor: isDragging ? 'grabbing' : 'grab', touchAction: 'none', flexShrink: 0 }}
                {...attributes}
                {...listeners}
              >
                <IconGripVertical size={16} />
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
