'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ActionIcon,
  Anchor,
  Badge,
  Box,
  Button,
  Group,
  Modal,
  Stepper,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { IconArrowLeft, IconTrash } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { useI18n } from '@/lib/i18n/client';
import { isBookPrintFresh } from '@/lib/book-print-status';
import type { PhotoBookStyle } from '@/lib/photo-book-plan';
import type { BookQuote } from '@/lib/gelato';
import {
  deleteBookAction,
  regeneratePhotoBookLayoutAction,
  renderPreviewAction,
  requestPhotoBookAiDesignAction,
  setPhotoBookStyleAction,
  setPhotoExcludedAction,
} from '../actions';
import type { OrderBook } from './order/order-view';
import { PhotoBookUploadStep } from './photo-book-upload-step';
import { PhotoBookCreateStep } from './photo-book-create-step';
import { PhotoBookOrderStep } from './photo-book-order-step';

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

export interface PhotoBookInfo {
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
   *  book's `layoutSource`. Also gates the step 2 auto-design trigger: it only ever
   *  fires when this is still 'auto' (never AI-designed or manually edited yet). */
  layoutSource: 'auto' | 'ai' | 'edited';
  /** True when the book's content changed since its stored layout plan was built — a
   *  `preview_ready` PDF built before that change is stale and must be re-rendered
   *  before it's handed out (the "Download PDF" flow below). */
  layoutStale: boolean;
  /** True once a print PDF exists in S3 (regardless of staleness). */
  hasPrint: boolean;
}

/**
 * The photo-book builder: a 3-step wizard — **1. Foto-Upload → 2. Fotobuch erstellen →
 * 3. Bestellen** — shown as a `Stepper` across the top so the user always sees where they
 * are. This file is the orchestrator: it owns every mutation (upload progress lives in
 * `BulkPhotoUploader`/step 1, everything else — style, design, regenerate, exclude/
 * include, delete, download — is a server action call + `router.refresh()`, same pattern
 * the old single-scroll builder used) and hands step-specific slices of state down to
 * `PhotoBookUploadStep` / `PhotoBookCreateStep` / `PhotoBookOrderStep`.
 *
 * Step gating: step 2 (and 3) only become reachable once every photo is *settled*
 * (`metaSettled` — scored or permanently failed, see `PhotoBookPhotoView`'s doc comment)
 * — `analysisComplete` below. The header steps themselves are fully controlled
 * (`active={step}`, `onStepClick`) rather than relying on Mantine's own
 * `allowNextStepsSelect`, so clicking a locked step is a deliberate no-op instead of
 * silently doing nothing.
 */
export function PhotoBookBuilder({
  book,
  photos,
  order,
  quote,
  contactEmail,
}: {
  book: PhotoBookInfo;
  photos: PhotoBookPhotoView[];
  order: OrderBook;
  quote: BookQuote | null;
  contactEmail: string;
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
  const [step, setStep] = useState(0);
  const isEdited = book.layoutSource === 'edited';

  const locked = book.status === 'ordered';
  const totalCount = photos.length;
  const settledCount = photos.filter((p) => p.metaSettled).length;
  const analysisComplete = totalCount > 0 && settledCount >= totalCount;

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

  // Auto-start the AI design pass the first time the user reaches step 2 with every
  // photo analyzed and no design pass has run yet on this plan (`layoutSource === 'auto'`
  // — deliberately excludes both 'ai' — a design pass already ran — and 'edited' — the
  // user's own manual edits, which must never be silently overwritten; see
  // `requestPhotoBookAiDesignAction`'s consent guard, unchanged and still reachable via
  // the manual "Design my book" button in step 2 for that case). `autoDesignTriggered`
  // fires this at most ONCE per mount of this component: without it, the gap between
  // calling the action and `book.designing` actually turning true on the next server
  // round trip could let the effect's dependencies re-evaluate and queue a second design
  // pass before the first one's `design_requested_at` has landed — a duplicate-trigger
  // race the ref closes off by flipping synchronously before the async call even starts.
  const autoDesignTriggered = useRef(false);
  useEffect(() => {
    if (step !== 1) return;
    if (autoDesignTriggered.current) return;
    if (!analysisComplete) return;
    if (book.designing) return;
    if (book.layoutSource !== 'auto') return;
    if (locked) return;
    autoDesignTriggered.current = true;
    designBook();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- designBook is stable for this component's lifetime; re-running on every dep change would defeat the once-only ref guard
  }, [step, analysisComplete, book.designing, book.layoutSource, locked]);

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

  /** The "Download PDF" button (docs/PHOTO_BOOK_PLAN.md PR5, the v1 deliverable, now
   *  living in step 3): if the book already has a fresh print PDF (`preview_ready` and
   *  not `layoutStale`), download it immediately. Otherwise trigger a render first
   *  (`renderPreviewAction` — the same action the order page's "prepare print proof"
   *  button calls, generalized in `lib/books.ts`'s `requestPreview` to cover photo books)
   *  and wait for it, so a book with a stale plan (photos added/excluded, a chat edit)
   *  never hands back an outdated PDF. */
  function downloadPdf() {
    if (isBookPrintFresh('photo', book.status, book.layoutStale)) {
      triggerDownload();
      return;
    }
    if (book.status === 'rendering') {
      // Some other trigger (a previous click) already has a render in flight — just
      // wait for it instead of surfacing "already rendering" as an error.
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

  /** The header steps are fully controlled — clicking a step beyond what's unlocked is a
   *  deliberate no-op (with a toast explaining why) rather than relying on Mantine's own
   *  `allowNextStepsSelect`, so the gating rule lives in one place (`analysisComplete`)
   *  instead of being split between this component and the Stepper's internal logic. */
  function goToStep(index: number) {
    if (index >= 1 && !analysisComplete) {
      notifications.show({ message: tp.waitingForAnalysis, color: 'yellow' });
      return;
    }
    setStep(index);
  }

  return (
    <Box>
      <Group justify="space-between" wrap="wrap" mb="md">
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

      {/* `keepMounted`: each step's content stays mounted (just hidden) instead of
          unmounting when you navigate away — the upload progress bar and the chat
          conversation (both local component state, nothing persisted server-side, see
          PhotoBookChat's doc comment) survive moving back and forth between steps. */}
      <Stepper active={step} onStepClick={goToStep} mb="lg" allowNextStepsSelect={false} keepMounted>
        <Stepper.Step label={tp.steps.upload} description={tp.stepUploadDescription}>
          <PhotoBookUploadStep
            bookId={book.id}
            photos={photos}
            locked={locked}
            pending={pending}
            onToggleExcluded={toggleExcluded}
            settledCount={settledCount}
            totalCount={totalCount}
            analysisComplete={analysisComplete}
            onNext={() => goToStep(1)}
          />
        </Stepper.Step>
        <Stepper.Step label={tp.steps.create} description={tp.stepCreateDescription}>
          <PhotoBookCreateStep
            bookId={book.id}
            book={book}
            photos={photos}
            locked={locked}
            pending={pending}
            onToggleExcluded={toggleExcluded}
            regenerating={regenerating}
            onRegenerate={regenerate}
            designPending={designPending}
            onDesignBook={designBook}
            onSetStyle={setStyle}
            onBack={() => setStep(0)}
            onNext={() => goToStep(2)}
          />
        </Stepper.Step>
        <Stepper.Step label={tp.steps.order} description={tp.stepOrderDescription}>
          <PhotoBookOrderStep
            order={order}
            quote={quote}
            contactEmail={contactEmail}
            totalCount={totalCount}
            downloadPdf={downloadPdf}
            downloadRequesting={downloadRequesting}
            awaitingDownload={awaitingDownload}
            onBack={() => setStep(1)}
          />
        </Stepper.Step>
      </Stepper>

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
    </Box>
  );
}
