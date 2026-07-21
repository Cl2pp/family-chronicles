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
  IconDownload,
  IconExternalLink,
  IconEye,
  IconEyeOff,
  IconPhoto,
  IconShoppingCart,
  IconSparkles,
  IconTrash,
} from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { useI18n } from '@/lib/i18n/client';
import { isBookPrintFresh } from '@/lib/book-print-status';
import { PHOTO_BOOK_STYLES, type PhotoBookStyle } from '@/lib/photo-book-plan';
import { BulkPhotoUploader } from '@/components/bulk-photo-uploader';
import {
  deleteBookAction,
  regeneratePhotoBookLayoutAction,
  renderPreviewAction,
  requestPhotoBookAiDesignAction,
  setPhotoBookStyleAction,
  setPhotoExcludedAction,
} from '../actions';
import { PhotoBookChat } from './photo-book-chat';

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
  errorMessage: string | null;
  /** Current style suite (`lib/photo-book-plan.ts`) — resolves/builds the plan
   *  server-side if there wasn't one yet, so this always has a value. */
  style: PhotoBookStyle;
  /** Cache-buster for the preview iframe — bumps whenever the book row changes
   *  (same pattern as the story builder's `previewVersion`). */
  previewVersion: number;
  /** True while an AI design pass is queued/running (books.design_requested_at). */
  designing: boolean;
  /** Who last wrote the layout plan — 'edited' once a chat op has touched it (PR4).
   *  Drives the "replace your manual edits?" consent modal below, same as the story
   *  book's `layoutSource`. */
  layoutSource: 'auto' | 'ai' | 'edited';
  /** True when the book's content changed since its stored layout plan was built — a
   *  `preview_ready` PDF built before that change is stale and must be re-rendered
   *  before it's handed out (the "Download PDF" flow below). */
  layoutStale: boolean;
  /** True once a print PDF exists in S3 (regardless of staleness). */
  hasPrint: boolean;
}

/**
 * The photo-book builder: bulk upload + a grid to review what's in the book so far
 * (exclude/include toggle, analysis-progress indicator — PR1 scope), plus the live
 * auto-generated preview, a style-suite picker, and a regenerate button (PR2 scope), an
 * AI "Design my book" pass whose progress is polled the same way the story builder polls
 * its own design pass (PR3 scope), and an embedded chat for typed/voice refinement via
 * targeted layout edits (PR4 scope, docs/PHOTO_BOOK_PLAN.md).
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
  const [designConsentOpen, setDesignConsentOpen] = useState(false);
  const [regenerateConsentOpen, setRegenerateConsentOpen] = useState(false);
  const [downloadRequesting, startDownloadRequest] = useTransition();
  // True while waiting for a triggered render to finish before the PDF can be downloaded
  // (as opposed to `downloadRequesting`, which only covers the initial "kick off the
  // render" request — the render itself runs in the worker and is polled for below).
  const [awaitingDownload, setAwaitingDownload] = useState(false);
  const isEdited = book.layoutSource === 'edited';

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

  // While a render triggered by the Download button is in flight, poll status the same
  // way the order page already does for its own print-proof render (order-view.tsx) —
  // once it settles, either download the PDF (preview_ready) or surface the failure.
  useEffect(() => {
    if (!awaitingDownload) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/books/${book.id}/status`);
        if (!res.ok) return;
        const data = (await res.json()) as { status: string };
        if (data.status === 'preview_ready') {
          setAwaitingDownload(false);
          triggerDownload();
          router.refresh();
        } else if (data.status === 'render_failed') {
          setAwaitingDownload(false);
          notifications.show({ message: tp.downloadFailed, color: 'red' });
          router.refresh();
        }
      } catch {
        /* transient network error — next tick retries */
      }
    }, 4000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- triggerDownload/tp are stable for this component's lifetime
  }, [awaitingDownload, book.id, router]);

  /** Saves the current print PDF to disk via a throwaway anchor — same pattern as any
   *  same-origin `download`-attribute link, just triggered from code once a render we
   *  were waiting on has finished. */
  function triggerDownload() {
    const a = document.createElement('a');
    a.href = `/api/books/${book.id}/print`;
    a.download = `${book.title}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /** The "Download PDF" button (docs/PHOTO_BOOK_PLAN.md PR5, the v1 deliverable): if the
   *  book already has a fresh print PDF (`preview_ready` and not `layoutStale`), download
   *  it immediately. Otherwise trigger a render first (`renderPreviewAction` — the same
   *  action the order page's "prepare print proof" button calls, generalized in
   *  `lib/books.ts`'s `requestPreview` to cover photo books) and wait for it, so a book
   *  with a stale plan (photos added/excluded, a chat edit) never hands back an outdated
   *  PDF. */
  function downloadPdf() {
    if (isBookPrintFresh('photo', book.status, book.layoutStale)) {
      triggerDownload();
      return;
    }
    if (book.status === 'rendering') {
      // Some other trigger (the order page, a previous click) already has a render in
      // flight — just wait for it instead of surfacing "already rendering" as an error.
      setAwaitingDownload(true);
      return;
    }
    startDownloadRequest(async () => {
      const result = await renderPreviewAction(book.id);
      if (result.error) {
        notifications.show({ message: result.error, color: 'red' });
        return;
      }
      setAwaitingDownload(true);
      router.refresh();
    });
  }

  /** Runs the AI design pass; if it fails with the "manual edits" consent error, opens
   *  the confirm modal instead of just showing the error — the retry (with
   *  overwriteEdits) happens from `confirmDesignOverwrite` below. Mirrors
   *  book-builder.tsx's `designBook`/`confirmOverwrite`. */
  function designBook() {
    startDesign(async () => {
      const result = await requestPhotoBookAiDesignAction({ bookId: book.id });
      if (!result.error) {
        router.refresh();
        return;
      }
      if (isEdited && result.error.toLowerCase().includes('manual edit')) {
        setDesignConsentOpen(true);
        return;
      }
      notifications.show({ message: result.error, color: 'red' });
    });
  }

  function confirmDesignOverwrite() {
    setDesignConsentOpen(false);
    startDesign(async () => {
      const result = await requestPhotoBookAiDesignAction({ bookId: book.id, overwriteEdits: true });
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
      const result = await regeneratePhotoBookLayoutAction({ bookId: book.id });
      if (!result.error) {
        router.refresh();
        return;
      }
      if (isEdited && result.error.toLowerCase().includes('manual edit')) {
        setRegenerateConsentOpen(true);
        return;
      }
      notifications.show({ message: result.error, color: 'red' });
    });
  }

  function confirmRegenerateOverwrite() {
    setRegenerateConsentOpen(false);
    startRegenerate(async () => {
      const result = await regeneratePhotoBookLayoutAction({ bookId: book.id, overwriteEdits: true });
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
        <Group gap="sm">
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
          <Button
            variant="default"
            leftSection={<IconDownload size={16} />}
            loading={downloadRequesting || awaitingDownload}
            disabled={totalCount === 0}
            onClick={downloadPdf}
          >
            {tp.downloadPdf}
          </Button>
          <Button
            component={Link}
            href={`/books/${book.id}/order`}
            leftSection={<IconShoppingCart size={16} />}
            disabled={!isBookPrintFresh('photo', book.status, book.layoutStale)}
          >
            {tb.orderCta}
          </Button>
        </Group>
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

      {/* ── Full-width AI chat: the way to change the book beyond the settings ── */}
      <PhotoBookChat bookId={book.id} locked={locked} />

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

      <Modal
        opened={designConsentOpen}
        onClose={() => setDesignConsentOpen(false)}
        title={tb.overwriteEditsTitle}
        centered
      >
        <Text size="sm">{tb.overwriteEditsBody}</Text>
        <Group justify="flex-end" mt="lg">
          <Button variant="default" onClick={() => setDesignConsentOpen(false)} disabled={designPending}>
            {tb.overwriteEditsCancel}
          </Button>
          <Button color="red" onClick={confirmDesignOverwrite} loading={designPending}>
            {tb.overwriteEditsConfirm}
          </Button>
        </Group>
      </Modal>

      <Modal
        opened={regenerateConsentOpen}
        onClose={() => setRegenerateConsentOpen(false)}
        title={tb.overwriteEditsTitle}
        centered
      >
        <Text size="sm">{tb.overwriteEditsBody}</Text>
        <Group justify="flex-end" mt="lg">
          <Button variant="default" onClick={() => setRegenerateConsentOpen(false)} disabled={regenerating}>
            {tb.overwriteEditsCancel}
          </Button>
          <Button color="red" onClick={confirmRegenerateOverwrite} loading={regenerating}>
            {tb.overwriteEditsConfirm}
          </Button>
        </Group>
      </Modal>
    </Stack>
  );
}
