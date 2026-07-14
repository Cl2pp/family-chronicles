'use client';

import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Group,
  Image,
  Modal,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Textarea,
  Title,
  Tooltip,
} from '@mantine/core';
import {
  IconArrowDown,
  IconArrowLeft,
  IconArrowsMaximize,
  IconArrowsMinimize,
  IconArrowUp,
  IconBookmark,
  IconExternalLink,
  IconFileTypePdf,
  IconInfoCircle,
  IconMessageCircle,
  IconPhoto,
  IconPlus,
  IconRefresh,
  IconShoppingCart,
  IconSparkles,
  IconX,
} from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { useI18n } from '@/lib/i18n/client';
import type { FigureSize, LayoutTheme, CoverStyle } from '@/lib/book-layout-plan';
import type { LayoutOp, LayoutImageBlockSummary } from '@/lib/books';
import {
  requestAiDesignAction,
  resetBookLayoutAction,
  setBookStoriesAction,
  updateBookAction,
  updateBookLayoutAction,
} from '../actions';

export interface CoverOption {
  assetId: string;
  url: string;
  caption: string | null;
}

export interface LayoutChapterData {
  storyId: string;
  images: (LayoutImageBlockSummary & { url: string })[];
}

interface Chapter {
  storyId: string;
  title: string;
  year: number | null;
  photoCount: number;
}

interface BuilderBook {
  id: string;
  title: string;
  subtitle: string | null;
  dedication: string | null;
  coverAssetId: string | null;
  format: 'hardcover-21x28' | 'hardcover-20x20';
  status: 'draft' | 'rendering' | 'preview_ready' | 'render_failed' | 'ordered';
  errorMessage: string | null;
  pageCount: number | null;
  hasPreview: boolean;
  /** Cache-buster for the preview iframe — bumps whenever the book row changes. */
  previewVersion: number;
  /** True while an AI design pass is queued/running (books.design_requested_at). */
  designing: boolean;
  /** Who last wrote the layout plan — 'edited' gates AI/reset behind a consent modal. */
  layoutSource: 'auto' | 'ai' | 'edited';
  theme: LayoutTheme;
  coverStyle: CoverStyle;
  chronicleName: string;
  chapters: Chapter[];
}

interface ChronicleStory {
  id: string;
  title: string;
  year: number | null;
}

/** full -> float-right -> float-left -> full. Row/grid photos (no current size) start
 *  the cycle at 'full', same as a fresh figure block would. */
function nextFigureSize(current: FigureSize | undefined): FigureSize {
  if (current === 'full') return 'float-right';
  if (current === 'float-right') return 'float-left';
  return 'full';
}

export function BookBuilder({
  book,
  chronicleStories,
  coverOptions,
  layoutChapters,
}: {
  book: BuilderBook;
  chronicleStories: ChronicleStory[];
  coverOptions: CoverOption[];
  layoutChapters: LayoutChapterData[];
}) {
  const { t } = useI18n();
  const tb = t.books.builder;
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const locked = book.status === 'ordered';
  const isEdited = book.layoutSource === 'edited';
  const included = new Set(book.chapters.map((c) => c.storyId));
  const notIncluded = chronicleStories.filter((s) => !included.has(s.id));

  // Settings form (uncontrolled-ish, saved on blur/submit)
  const [title, setTitle] = useState(book.title);
  const [subtitle, setSubtitle] = useState(book.subtitle ?? '');
  const [dedication, setDedication] = useState(book.dedication ?? '');

  // Gated behind a consent modal when the current plan has manual edits — 'design' and
  // 'reset' both mean "replace the layout plan", which would silently discard those
  // edits without confirmation.
  const [consentAction, setConsentAction] = useState<'design' | 'reset' | null>(null);

  // No status polling for the render lifecycle — the preview pane is live HTML (see
  // below), always current. The one thing still worth polling for is the AI design
  // pass: it rewrites the layout plan server-side (worker process) with no other
  // signal the client can see, so we poll while `designing` is true and refresh once
  // it clears — the preview iframe then re-keys on the new `previewVersion`.
  useEffect(() => {
    if (!book.designing) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/books/${book.id}/status`);
        if (!res.ok) return;
        const data = (await res.json()) as { designing: boolean };
        if (!data.designing) router.refresh();
      } catch {
        /* transient network error — next tick retries */
      }
    }, 4000);
    return () => clearInterval(timer);
  }, [book.designing, book.id, router]);

  function run(action: () => Promise<{ error?: string }>) {
    startTransition(async () => {
      const result = await action();
      if (result.error) notifications.show({ message: result.error, color: 'red' });
    });
  }

  /** Runs `action`; if it fails with the "manual edits" consent error, opens the confirm
   *  modal instead of just showing the error — the retry (with overwriteEdits) happens
   *  from `confirmOverwrite` below. */
  function runConsentGated(kind: 'design' | 'reset', action: () => Promise<{ error?: string }>) {
    startTransition(async () => {
      const result = await action();
      if (!result.error) {
        router.refresh();
        return;
      }
      if (isEdited && result.error.toLowerCase().includes('manual edit')) {
        setConsentAction(kind);
        return;
      }
      notifications.show({ message: result.error, color: 'red' });
    });
  }

  function designBook() {
    runConsentGated('design', () => requestAiDesignAction({ bookId: book.id }));
  }

  function resetLayout() {
    runConsentGated('reset', () => resetBookLayoutAction({ bookId: book.id }));
  }

  function confirmOverwrite() {
    const kind = consentAction;
    setConsentAction(null);
    if (kind === 'design') {
      run(async () => {
        const r = await requestAiDesignAction({ bookId: book.id, overwriteEdits: true });
        if (!r.error) router.refresh();
        return r;
      });
    } else if (kind === 'reset') {
      run(async () => {
        const r = await resetBookLayoutAction({ bookId: book.id, overwriteEdits: true });
        if (!r.error) router.refresh();
        return r;
      });
    }
  }

  function saveSettings(patch: Parameters<typeof updateBookAction>[0]) {
    run(() => updateBookAction(patch));
  }

  function applyLayoutOp(op: LayoutOp) {
    run(async () => {
      const r = await updateBookLayoutAction({ bookId: book.id, ops: [op] });
      if (!r.error) router.refresh();
      return r;
    });
  }

  function moveChapter(index: number, delta: -1 | 1) {
    const ids = book.chapters.map((c) => c.storyId);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    run(() => setBookStoriesAction({ bookId: book.id, storyIds: ids }));
  }

  function removeChapter(storyId: string) {
    const ids = book.chapters.map((c) => c.storyId).filter((id) => id !== storyId);
    run(() => setBookStoriesAction({ bookId: book.id, storyIds: ids }));
  }

  function addChapter(storyId: string) {
    const ids = [...book.chapters.map((c) => c.storyId), storyId];
    run(() => setBookStoriesAction({ bookId: book.id, storyIds: ids }));
  }

  // Group each chapter's flat image list by blockIndex — a photo-row/photo-grid
  // contributes several entries sharing one blockIndex (see getBookLayoutSummary in
  // lib/books.ts); move_block operates on the whole block, size/photo-page ops on one
  // photo within it.
  function blocksForChapter(storyId: string) {
    const images = layoutChapters.find((c) => c.storyId === storyId)?.images ?? [];
    const byIndex = new Map<number, LayoutChapterData['images']>();
    for (const img of images) {
      const arr = byIndex.get(img.blockIndex) ?? [];
      arr.push(img);
      byIndex.set(img.blockIndex, arr);
    }
    return [...byIndex.entries()].sort((a, b) => a[0] - b[0]);
  }

  return (
    <Stack gap="md">
      <Group justify="space-between" wrap="wrap">
        <Group gap="sm">
          <Anchor component={Link} href="/books" fz={13} c="dimmed">
            <Group gap={4}>
              <IconArrowLeft size={14} />
              {tb.backToBooks}
            </Group>
          </Anchor>
          <Title order={2}>{book.title}</Title>
          <Badge variant="light">{t.books.status[book.status]}</Badge>
        </Group>
        <Group gap="sm">
          <Tooltip label={tb.editWithAIHint}>
            <Button
              component={Link}
              href="/chat"
              variant="light"
              leftSection={<IconMessageCircle size={16} />}
            >
              {tb.editWithAI}
            </Button>
          </Tooltip>
          <Button
            component={Link}
            href={`/books/${book.id}/order`}
            leftSection={<IconShoppingCart size={16} />}
            disabled={book.status !== 'preview_ready'}
          >
            {tb.orderCta}
          </Button>
        </Group>
      </Group>

      {locked && (
        <Alert color="grape" icon={<IconInfoCircle size={16} />}>
          {tb.orderedNote}
        </Alert>
      )}

      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        {/* ── Left: chapters + settings + layout ─────────────── */}
        <Stack gap="md">
          <Card withBorder radius="md" p="md">
            <Title order={4} mb={4}>
              {tb.chapters}
            </Title>
            <Text fz={13} c="dimmed" mb="sm">
              {tb.chaptersHint}
            </Text>
            <Stack gap={6}>
              {book.chapters.map((c, i) => (
                <Group key={c.storyId} justify="space-between" wrap="nowrap" gap={8}>
                  <Text fz={14} truncate style={{ flex: 1 }}>
                    {i + 1}. {c.title}
                    {c.year ? (
                      <Text span c="dimmed" fz={12}>
                        {' '}
                        ({c.year})
                      </Text>
                    ) : null}
                    {c.photoCount > 0 && (
                      <Text span c="dimmed" fz={12}>
                        {' '}
                        · <IconPhoto size={11} style={{ verticalAlign: -1 }} /> {c.photoCount}
                      </Text>
                    )}
                  </Text>
                  {!locked && (
                    <Group gap={2} wrap="nowrap">
                      <ActionIcon
                        variant="subtle"
                        size="sm"
                        aria-label={tb.moveUp}
                        disabled={i === 0 || pending}
                        onClick={() => moveChapter(i, -1)}
                      >
                        <IconArrowUp size={14} />
                      </ActionIcon>
                      <ActionIcon
                        variant="subtle"
                        size="sm"
                        aria-label={tb.moveDown}
                        disabled={i === book.chapters.length - 1 || pending}
                        onClick={() => moveChapter(i, 1)}
                      >
                        <IconArrowDown size={14} />
                      </ActionIcon>
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        size="sm"
                        aria-label={tb.removeStory}
                        disabled={book.chapters.length <= 1 || pending}
                        onClick={() => removeChapter(c.storyId)}
                      >
                        <IconX size={14} />
                      </ActionIcon>
                    </Group>
                  )}
                </Group>
              ))}
            </Stack>

            {!locked && notIncluded.length > 0 && (
              <>
                <Title order={6} mt="md" mb={2} c="dimmed">
                  {tb.moreStories}
                </Title>
                <Text fz={12} c="dimmed" mb="xs">
                  {tb.moreStoriesHint}
                </Text>
                <Stack gap={4}>
                  {notIncluded.map((s) => (
                    <Group key={s.id} justify="space-between" wrap="nowrap">
                      <Text fz={13} c="dimmed" truncate>
                        {s.title}
                        {s.year ? ` (${s.year})` : ''}
                      </Text>
                      <Button
                        size="compact-xs"
                        variant="light"
                        leftSection={<IconPlus size={12} />}
                        disabled={pending}
                        onClick={() => addChapter(s.id)}
                      >
                        {tb.addStory}
                      </Button>
                    </Group>
                  ))}
                </Stack>
              </>
            )}
          </Card>

          <Card withBorder radius="md" p="md">
            <Title order={4} mb="sm">
              {tb.settings}
            </Title>
            <Stack gap="sm">
              <TextInput
                label={tb.bookTitle}
                value={title}
                disabled={locked}
                onChange={(e) => setTitle(e.currentTarget.value)}
                onBlur={() => title.trim() !== book.title && saveSettings({ bookId: book.id, title })}
              />
              <TextInput
                label={tb.subtitle}
                value={subtitle}
                disabled={locked}
                onChange={(e) => setSubtitle(e.currentTarget.value)}
                onBlur={() =>
                  subtitle !== (book.subtitle ?? '') &&
                  saveSettings({ bookId: book.id, subtitle: subtitle || null })
                }
              />
              <Textarea
                label={tb.dedication}
                description={tb.dedicationHint}
                value={dedication}
                autosize
                minRows={2}
                disabled={locked}
                onChange={(e) => setDedication(e.currentTarget.value)}
                onBlur={() =>
                  dedication !== (book.dedication ?? '') &&
                  saveSettings({ bookId: book.id, dedication: dedication || null })
                }
              />
              <Select
                label={tb.format}
                value={book.format}
                disabled={locked}
                data={[
                  { value: 'hardcover-21x28', label: 'Hardcover 21 × 28 cm' },
                  { value: 'hardcover-20x20', label: 'Hardcover 20 × 20 cm' },
                ]}
                onChange={(v) =>
                  v && v !== book.format &&
                  saveSettings({ bookId: book.id, format: v as BuilderBook['format'] })
                }
                allowDeselect={false}
              />
              <Select
                label={tb.theme}
                value={book.theme}
                disabled={locked}
                data={[
                  { value: 'classic', label: tb.themeOptions.classic },
                  { value: 'modern', label: tb.themeOptions.modern },
                ]}
                onChange={(v) =>
                  v && v !== book.theme && applyLayoutOp({ op: 'set_theme', theme: v as LayoutTheme })
                }
                allowDeselect={false}
              />
              <Select
                label={tb.coverStyle}
                value={book.coverStyle}
                disabled={locked}
                data={[
                  { value: 'framed', label: tb.coverStyleOptions.framed },
                  { value: 'full-bleed', label: tb.coverStyleOptions['full-bleed'] },
                ]}
                onChange={(v) =>
                  v &&
                  v !== book.coverStyle &&
                  applyLayoutOp({ op: 'set_cover_style', style: v as CoverStyle })
                }
                allowDeselect={false}
              />

              <Box>
                <Text fz={14} fw={500} mb={2}>
                  {tb.cover}
                </Text>
                <Text fz={12} c="dimmed" mb={6}>
                  {tb.coverHint}
                </Text>
                <Group gap={6}>
                  <Card
                    withBorder
                    p={4}
                    radius="sm"
                    style={{
                      cursor: locked ? 'default' : 'pointer',
                      outline: !book.coverAssetId
                        ? '2px solid var(--mantine-color-brand-5)'
                        : undefined,
                      width: 72,
                      height: 72,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                    onClick={() =>
                      !locked && book.coverAssetId &&
                      saveSettings({ bookId: book.id, coverAssetId: null })
                    }
                  >
                    <Text fz={9} c="dimmed" ta="center">
                      {tb.autoCover}
                    </Text>
                  </Card>
                  {coverOptions.map((c) => (
                    <Card
                      key={c.assetId}
                      withBorder
                      p={0}
                      radius="sm"
                      style={{
                        cursor: locked ? 'default' : 'pointer',
                        outline:
                          book.coverAssetId === c.assetId
                            ? '2px solid var(--mantine-color-brand-5)'
                            : undefined,
                        overflow: 'hidden',
                        width: 72,
                        height: 72,
                      }}
                      onClick={() =>
                        !locked &&
                        book.coverAssetId !== c.assetId &&
                        saveSettings({ bookId: book.id, coverAssetId: c.assetId })
                      }
                    >
                      <Image src={c.url} alt={c.caption ?? ''} w={72} h={72} fit="cover" />
                    </Card>
                  ))}
                </Group>
              </Box>
            </Stack>
          </Card>

          <Card withBorder radius="md" p="md">
            <Group justify="space-between" mb={4} wrap="wrap">
              <Title order={4}>{tb.layout}</Title>
              {!locked && (
                <Tooltip label={tb.resetLayoutHint}>
                  <Button
                    variant="subtle"
                    size="compact-sm"
                    leftSection={<IconRefresh size={14} />}
                    disabled={pending}
                    onClick={resetLayout}
                  >
                    {tb.resetLayout}
                  </Button>
                </Tooltip>
              )}
            </Group>
            <Text fz={13} c="dimmed" mb={isEdited ? 4 : 'sm'}>
              {tb.layoutHint}
            </Text>
            {isEdited && (
              <Text fz={12} c="brand" mb="sm">
                {tb.layoutEditedNote}
              </Text>
            )}
            <Stack gap="md">
              {book.chapters.map((chapter) => {
                const blocks = blocksForChapter(chapter.storyId);
                if (blocks.length === 0) return null;
                return (
                  <Box key={chapter.storyId}>
                    <Text fz={13} fw={500} mb={4} truncate>
                      {chapter.title}
                    </Text>
                    <Stack gap={4}>
                      {blocks.map(([blockIndex, images], i) => (
                        <Card key={blockIndex} withBorder radius="sm" p={6}>
                          <Group justify="space-between" wrap="nowrap" align="flex-start" gap={8}>
                            <Group gap={6} wrap="nowrap" align="flex-start">
                              {images.map((img) => {
                                const label =
                                  img.type === 'figure'
                                    ? tb.figureSizeOptions[img.size ?? 'full']
                                    : img.type === 'photo-page'
                                      ? tb.photoPageLabel
                                      : img.type === 'photo-row'
                                        ? tb.photoRowLabel
                                        : tb.photoGridLabel;
                                return (
                                  <Stack key={img.assetId} gap={2} align="center" style={{ width: 52 }}>
                                    {img.url ? (
                                      <Image src={img.url} alt={img.caption ?? ''} w={44} h={44} fit="cover" radius={4} />
                                    ) : (
                                      <Box w={44} h={44} bg="slate.1" style={{ borderRadius: 4 }} />
                                    )}
                                    <Text fz={9} c="dimmed" ta="center" lineClamp={1}>
                                      {label}
                                    </Text>
                                    <Group gap={2} wrap="nowrap">
                                      {img.type !== 'photo-page' && (
                                        <Tooltip label={tb.cycleSize}>
                                          <ActionIcon
                                            size="xs"
                                            variant="subtle"
                                            disabled={locked || pending}
                                            onClick={() =>
                                              applyLayoutOp({
                                                op: 'set_figure_size',
                                                assetId: img.assetId,
                                                size: nextFigureSize(img.size),
                                              })
                                            }
                                          >
                                            <IconArrowsMaximize size={11} />
                                          </ActionIcon>
                                        </Tooltip>
                                      )}
                                      <Tooltip
                                        label={img.type === 'photo-page' ? tb.demoteFromPhotoPage : tb.promoteToPhotoPage}
                                      >
                                        <ActionIcon
                                          size="xs"
                                          variant="subtle"
                                          disabled={locked || pending}
                                          onClick={() =>
                                            applyLayoutOp(
                                              img.type === 'photo-page'
                                                ? { op: 'demote_photo_page', assetId: img.assetId }
                                                : { op: 'promote_photo_page', assetId: img.assetId },
                                            )
                                          }
                                        >
                                          {img.type === 'photo-page' ? (
                                            <IconArrowsMinimize size={11} />
                                          ) : (
                                            <IconBookmark size={11} />
                                          )}
                                        </ActionIcon>
                                      </Tooltip>
                                    </Group>
                                  </Stack>
                                );
                              })}
                            </Group>
                            <Group gap={2} wrap="nowrap">
                              <ActionIcon
                                size="sm"
                                variant="subtle"
                                aria-label={tb.moveBlockUp}
                                disabled={locked || pending || i === 0}
                                onClick={() =>
                                  applyLayoutOp({
                                    op: 'move_block',
                                    storyId: chapter.storyId,
                                    blockIndex,
                                    direction: 'up',
                                  })
                                }
                              >
                                <IconArrowUp size={13} />
                              </ActionIcon>
                              <ActionIcon
                                size="sm"
                                variant="subtle"
                                aria-label={tb.moveBlockDown}
                                disabled={locked || pending || i === blocks.length - 1}
                                onClick={() =>
                                  applyLayoutOp({
                                    op: 'move_block',
                                    storyId: chapter.storyId,
                                    blockIndex,
                                    direction: 'down',
                                  })
                                }
                              >
                                <IconArrowDown size={13} />
                              </ActionIcon>
                            </Group>
                          </Group>
                        </Card>
                      ))}
                    </Stack>
                  </Box>
                );
              })}
              {layoutChapters.every((c) => c.images.length === 0) && (
                <Text fz={13} c="dimmed">
                  {tb.layoutEmpty}
                </Text>
              )}
            </Stack>
          </Card>
        </Stack>

        {/* ── Right: preview ────────────────────────────────── */}
        <Card withBorder radius="md" p="md" style={{ minHeight: 480 }}>
          <Group justify="space-between" mb="sm" wrap="wrap">
            <Title order={4}>{tb.preview}</Title>
            <Group gap="sm">
              <Anchor href={`/api/books/${book.id}/preview-html`} target="_blank" fz={13}>
                <Group gap={4}>
                  <IconExternalLink size={14} />
                  {tb.openInNewTab}
                </Group>
              </Anchor>
              {book.hasPreview && (
                <Anchor href={`/api/books/${book.id}/preview`} target="_blank" fz={13}>
                  <Group gap={4}>
                    <IconFileTypePdf size={14} />
                    {tb.pdfProof}
                  </Group>
                </Anchor>
              )}
            </Group>
          </Group>

          <Tooltip label={tb.designBookHint} disabled={locked}>
            <Button
              variant="light"
              size="sm"
              mb="sm"
              leftSection={<IconSparkles size={16} />}
              loading={book.designing}
              disabled={locked || pending}
              onClick={designBook}
            >
              {book.designing ? tb.designingBook : tb.designBook}
            </Button>
          </Tooltip>

          <Box
            component="iframe"
            key={book.previewVersion}
            src={`/api/books/${book.id}/preview-html?v=${book.previewVersion}`}
            style={{
              width: '100%',
              height: 560,
              border: '1px solid var(--mantine-color-slate-2)',
              borderRadius: 8,
              background: '#fff',
            }}
            title={tb.preview}
          />
          <Text fz={11} c="dimmed" mt={6}>
            {tb.livePreviewNote}
            {book.pageCount ? ` · ${t.books.pageCount(book.pageCount)}` : ''}
          </Text>
        </Card>
      </SimpleGrid>

      <Modal
        opened={consentAction != null}
        onClose={() => setConsentAction(null)}
        title={tb.overwriteEditsTitle}
        centered
      >
        <Text size="sm">{tb.overwriteEditsBody}</Text>
        <Group justify="flex-end" mt="lg">
          <Button variant="default" onClick={() => setConsentAction(null)} disabled={pending}>
            {tb.overwriteEditsCancel}
          </Button>
          <Button color="red" onClick={confirmOverwrite} loading={pending}>
            {tb.overwriteEditsConfirm}
          </Button>
        </Group>
      </Modal>
    </Stack>
  );
}
