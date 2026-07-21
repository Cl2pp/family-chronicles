'use client';

import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ActionIcon,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Group,
  Image,
  Modal,
  Overlay,
  SimpleGrid,
  Stack,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import {
  IconArrowLeft,
  IconExternalLink,
  IconEye,
  IconEyeOff,
  IconPhoto,
  IconSparkles,
  IconTrash,
} from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { useI18n } from '@/lib/i18n/client';
import { PHOTO_BOOK_STYLES, type PhotoBookStyle } from '@/lib/photo-book-plan';
import { BulkPhotoUploader } from '@/components/bulk-photo-uploader';
import {
  deleteBookAction,
  regeneratePhotoBookLayoutAction,
  requestPhotoBookAiDesignAction,
  setPhotoBookStyleAction,
  setPhotoExcludedAction,
} from '../actions';

export interface PhotoBookPhotoView {
  assetId: string;
  url: string;
  excluded: boolean;
  /** True once the `photo-vision` pass has settled for this photo — scored
   *  successfully, or permanently gave up after its retries (`lib/books.ts`'s
   *  `BookPhotoItem.metaSettled`). */
  metaSettled: boolean;
  /** True when analysis permanently failed for this photo. */
  metaFailed: boolean;
}

interface PhotoBookInfo {
  id: string;
  title: string;
  status: 'draft' | 'rendering' | 'preview_ready' | 'render_failed' | 'ordered';
  /** Current style suite (`lib/photo-book-plan.ts`) — resolves/builds the plan
   *  server-side if there wasn't one yet, so this always has a value. */
  style: PhotoBookStyle;
  /** Cache-buster for the preview iframe — bumps whenever the book row changes
   *  (same pattern as the story builder's `previewVersion`). */
  previewVersion: number;
  /** True while an AI design pass is queued/running (books.design_requested_at). */
  designing: boolean;
}

/**
 * The photo-book builder: bulk upload + a grid to review what's in the book so far
 * (exclude/include toggle, analysis-progress indicator — PR1 scope), plus the live
 * auto-generated preview, a style-suite picker, and a regenerate button (PR2 scope), and
 * an AI "Design my book" pass whose progress is polled the same way the story builder
 * polls its own design pass (PR3 scope, docs/PHOTO_BOOK_PLAN.md). Chat/voice refinement
 * and targeted layout edits are a later PR.
 */
export function PhotoBookBuilder({
  book,
  photos,
}: {
  book: PhotoBookInfo;
  photos: PhotoBookPhotoView[];
}) {
  const { t } = useI18n();
  const tb = t.books.builder;
  const tp = tb.photoBook;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [regenerating, startRegenerate] = useTransition();
  const [designPending, startDesign] = useTransition();
  const [deleteOpen, setDeleteOpen] = useState(false);

  const locked = book.status === 'ordered';
  const totalCount = photos.length;
  const settledCount = photos.filter((p) => p.metaSettled).length;
  const failedCount = photos.filter((p) => p.metaFailed).length;

  // Analysis runs server-side (the `photo-meta` and `photo-vision` worker jobs) with no
  // other signal the client can see — poll while photos are still unsettled, same
  // pattern as the story-book builder's "designing" poll (book-builder.tsx). A photo
  // whose analysis permanently failed still counts as settled (see `metaSettled`), so a
  // genuinely unscoreable photo can't leave this polling forever.
  useEffect(() => {
    if (totalCount === 0 || settledCount >= totalCount) return;
    const timer = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(timer);
  }, [totalCount, settledCount, router]);

  // The AI design pass rewrites the layout plan server-side (worker process) with no
  // other signal the client can see — poll while `book.designing` is true and refresh
  // once it clears, same pattern as the story builder's design poll (book-builder.tsx).
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

  function designBook() {
    startDesign(async () => {
      const result = await requestPhotoBookAiDesignAction(book.id);
      if (result.error) {
        notifications.show({ message: result.error, color: 'red' });
        return;
      }
      router.refresh();
    });
  }

  function setStyle(style: PhotoBookStyle) {
    if (style === book.style) return;
    startTransition(async () => {
      const result = await setPhotoBookStyleAction({ bookId: book.id, style });
      if (result.error) {
        notifications.show({ message: result.error, color: 'red' });
        return;
      }
      router.refresh();
    });
  }

  function regenerate() {
    startRegenerate(async () => {
      const result = await regeneratePhotoBookLayoutAction(book.id);
      if (result.error) {
        notifications.show({ message: result.error, color: 'red' });
        return;
      }
      router.refresh();
    });
  }

  function toggleExcluded(assetId: string, excluded: boolean) {
    startTransition(async () => {
      const result = await setPhotoExcludedAction({ bookId: book.id, assetId, excluded });
      if (result.error) {
        notifications.show({ message: result.error, color: 'red' });
        return;
      }
      router.refresh();
    });
  }

  function confirmDelete() {
    startTransition(async () => {
      const result = await deleteBookAction(book.id);
      if (result.error) {
        setDeleteOpen(false);
        notifications.show({ message: result.error, color: 'red' });
        return;
      }
      router.push('/books');
    });
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
        {!locked && (
          <Tooltip label={tb.deleteBook}>
            <ActionIcon
              variant="subtle"
              color="red"
              size="lg"
              aria-label={tb.deleteBook}
              disabled={pending}
              onClick={() => setDeleteOpen(true)}
            >
              <IconTrash size={18} />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>

      {!locked && (
        <Card withBorder radius="md" p="md">
          <BulkPhotoUploader bookId={book.id} />
        </Card>
      )}

      <Card withBorder radius="md" p="md">
        <Group justify="space-between" mb="sm" wrap="wrap">
          <Title order={4}>{tp.photos}</Title>
          {totalCount > 0 && (
            <Text fz={13} c="dimmed">
              {tp.analyzedProgress(settledCount, totalCount)}
            </Text>
          )}
        </Group>
        {failedCount > 0 && (
          <Text fz={12} c="dimmed" mb="sm">
            {tp.someUnanalyzed(failedCount)}
          </Text>
        )}

        {totalCount === 0 ? (
          <Stack align="center" gap={4} py="xl">
            <IconPhoto size={28} stroke={1.4} color="var(--mantine-color-slate-4)" />
            <Text c="dimmed" ta="center">
              {tp.noPhotosYet}
            </Text>
            <Text fz={12} c="dimmed" ta="center">
              {tp.noPhotosHint}
            </Text>
          </Stack>
        ) : (
          <SimpleGrid cols={{ base: 2, xs: 3, sm: 4, md: 5 }} spacing="xs">
            {photos.map((p) => (
              <Box key={p.assetId} pos="relative">
                <Card
                  withBorder
                  p={0}
                  radius="sm"
                  style={{ overflow: 'hidden', aspectRatio: '1 / 1' }}
                >
                  <Image src={p.url} alt="" w="100%" h="100%" fit="cover" />
                  {p.excluded && <Overlay color="#000" backgroundOpacity={0.5} />}
                </Card>
                {!locked && (
                  <Tooltip label={p.excluded ? tp.include : tp.exclude}>
                    <ActionIcon
                      variant="filled"
                      color={p.excluded ? 'gray' : 'dark'}
                      size="sm"
                      radius="xl"
                      aria-label={p.excluded ? tp.include : tp.exclude}
                      disabled={pending}
                      style={{ position: 'absolute', top: 4, right: 4 }}
                      onClick={() => toggleExcluded(p.assetId, !p.excluded)}
                    >
                      {p.excluded ? <IconEye size={14} /> : <IconEyeOff size={14} />}
                    </ActionIcon>
                  </Tooltip>
                )}
                {!p.metaSettled && (
                  <Badge
                    size="xs"
                    variant="light"
                    color="gray"
                    style={{ position: 'absolute', bottom: 4, left: 4 }}
                  >
                    {tp.analyzing}
                  </Badge>
                )}
                {p.metaFailed && (
                  <Badge
                    size="xs"
                    variant="light"
                    color="red"
                    style={{ position: 'absolute', bottom: 4, left: 4 }}
                  >
                    {tp.analysisFailed}
                  </Badge>
                )}
              </Box>
            ))}
          </SimpleGrid>
        )}
      </Card>

      <Card withBorder radius="md" p="md">
        <Group justify="space-between" mb="sm" wrap="wrap">
          <Title order={4}>{tp.preview}</Title>
          <Anchor href={`/api/books/${book.id}/preview-html`} target="_blank" fz={13}>
            <Group gap={4}>
              <IconExternalLink size={14} />
              {tb.openInNewTab}
            </Group>
          </Anchor>
        </Group>
        <Text fz={12} c="dimmed" mb="sm">
          {tp.previewHint}
        </Text>

        <Text fz={13} fw={500} mb={6}>
          {tp.style}
        </Text>
        <Group gap={8} mb="md">
          {PHOTO_BOOK_STYLES.map((style) => (
            <Button
              key={style}
              size="compact-sm"
              variant={style === book.style ? 'filled' : 'default'}
              disabled={locked || pending}
              onClick={() => setStyle(style)}
            >
              {tp.styleNames[style]}
            </Button>
          ))}
        </Group>

        <Group mb="sm">
          <Tooltip label={tb.designBookHint} disabled={locked}>
            <Button
              variant="light"
              size="sm"
              leftSection={<IconSparkles size={16} />}
              loading={book.designing}
              disabled={locked || totalCount === 0 || designPending}
              onClick={designBook}
            >
              {book.designing ? tb.designingBook : tb.designBook}
            </Button>
          </Tooltip>
          <Tooltip label={tp.regenerateHint} disabled={locked}>
            <Button
              variant="light"
              size="sm"
              leftSection={<IconSparkles size={16} />}
              loading={regenerating}
              disabled={locked || totalCount === 0}
              onClick={regenerate}
            >
              {regenerating ? tp.regenerating : tp.regenerate}
            </Button>
          </Tooltip>
        </Group>

        {settledCount > 0 ? (
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
            title={tp.preview}
          />
        ) : (
          <Stack align="center" gap={4} py="xl">
            <IconPhoto size={28} stroke={1.4} color="var(--mantine-color-slate-4)" />
            <Text c="dimmed" ta="center">
              {tp.waitingForPhotos}
            </Text>
          </Stack>
        )}
      </Card>

      <Modal
        opened={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title={tb.deleteConfirmTitle}
        centered
      >
        <Text size="sm">{tb.deleteConfirmBody}</Text>
        <Group justify="flex-end" mt="lg">
          <Button variant="default" onClick={() => setDeleteOpen(false)} disabled={pending}>
            {t.common.cancel}
          </Button>
          <Button color="red" onClick={confirmDelete} loading={pending}>
            {tb.deleteConfirm}
          </Button>
        </Group>
      </Modal>
    </Stack>
  );
}
