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
import { canAccessPhotoBookStep } from '@/lib/photo-book-step-gate';
import type { PhotoBookDesignStage } from '@/lib/photo-book-design-stage';
import { groupingCoverage, type PhotoBookGrouping } from '@/lib/photo-book-grouping';
import type { PhotoBookStyle } from '@/lib/photo-book-plan';
import type { BookCoverType, BookFormat, BookQuote } from '@/lib/gelato';
import {
  deleteBookAction,
  regeneratePhotoBookLayoutAction,
  renderPreviewAction,
  requestPhotoBookAiDesignAction,
  setPhotoBookStyleAction,
  setPhotoExcludedAction,
  updatePhotoBookSettingsAction,
} from '../actions';
import type { OrderBook } from './order/order-view';
import { PhotoBookUploadStep } from './photo-book-upload-step';
import type { BookChapterView, ChronicleStoryOption } from './book-stories-panel';
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
  /** Whether this photo has EXIF GPS / a vision score — the two things the by-place and
   *  by-topic groupings cluster on. The config panel warns when a chosen grouping has too
   *  little of what it needs (see `PhotoBookConfigPanel`). */
  hasLocation: boolean;
  hasAnalysis: boolean;
}

export interface PhotoBookInfo {
  id: string;
  title: string;
  /** Front cover subtitle (`books.subtitle`) — the config panel's "Untertitel" field.
   *  Unlike story books, this always feeds the photo book's actual printed cover. */
  subtitle: string | null;
  /** Printed on the title page; only shown/used for a book that has chapters. */
  dedication: string | null;
  /** How many story chapters the book holds — drives the chapter-only settings. */
  chapterCount: number;
  status: 'draft' | 'rendering' | 'preview_ready' | 'render_failed' | 'ordered';
  errorMessage: string | null;
  /** Current style suite (`lib/photo-book-plan.ts`) — resolves/builds the plan
   *  server-side if there wasn't one yet, so this always has a value. */
  style: PhotoBookStyle;
  /** Trim SIZE only (`books.format`) — despite the "hardcover-" in its values, this is
   *  not a binding choice; see `bookFormat`'s comment in db/schema.ts. The config
   *  panel labels these as sizes ("21×28 (Hochformat)" / "20×20 (Quadratisch)"), never
   *  as "hardcover"/"softcover" — that's `coverType` below. */
  format: BookFormat;
  /** Hardcover vs softcover binding (`books.cover_type`) — the config panel's actual
   *  binding toggle, orthogonal to `format`. */
  coverType: BookCoverType;
  /** Cache-buster for the preview iframe — bumps whenever the book row changes
   *  (same pattern as the story builder's `previewVersion`). */
  previewVersion: number;
  /** True while an AI design pass is queued/running (books.design_requested_at). */
  designing: boolean;
  /** How far that pass has got (`books.design_stage`) — drives Step 2's progress
   *  checklist. Null when nothing is running. */
  designStage: PhotoBookDesignStage | null;
  /** How the user asked the book to be organised (`books.photo_grouping`) — chronological,
   *  by topic, or by place. Feeds both layout producers; see `lib/photo-book-grouping.ts`. */
  photoGrouping: PhotoBookGrouping;
  /** ISO timestamp of the last time a design job completed for this book (success or
   *  auto-fallback), or null if it never has — `books.generated_at`. This is the Step 2
   *  gate: null means show the config-only "not generated yet" view, non-null means show
   *  the live book (still editable/regeneratable). Distinct from `designing`, which only
   *  tracks whether a pass is CURRENTLY in flight. */
  generatedAt: string | null;
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
  chapters,
  chronicleStories,
  hiddenChapterCount,
  order,
  quote,
  contactEmail,
}: {
  book: PhotoBookInfo;
  photos: PhotoBookPhotoView[];
  chapters: BookChapterView[];
  chronicleStories: ChronicleStoryOption[];
  hiddenChapterCount: number;
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
  // A grouping the photos can't carry, waiting for the user to confirm the switch.
  const [groupingConfirm, setGroupingConfirm] = useState<PhotoBookGrouping | null>(null);
  const [regenerateConsentOpen, setRegenerateConsentOpen] = useState(false);
  const [downloadRequesting, startDownloadRequest] = useTransition();
  // True while waiting for a triggered render to finish before the PDF can be downloaded
  // (as opposed to `downloadRequesting`, which only covers the initial "kick off the
  // render" request — the render itself runs in the worker and is polled for below).
  const [awaitingDownload, setAwaitingDownload] = useState(false);
  const [designStage, setDesignStage] = useState<PhotoBookDesignStage | null>(book.designStage);
  const [serverStage, setServerStage] = useState<PhotoBookDesignStage | null>(book.designStage);
  const isEdited = book.layoutSource === 'edited';

  const locked = book.status === 'ordered';
  const totalCount = photos.length;
  const settledCount = photos.filter((p) => p.metaSettled).length;
  // Vacuously true with no photos — which is now a legitimate state (a text-only book),
  // so `hasContent` below is what actually gates leaving step 1.
  const analysisComplete = totalCount === 0 || settledCount >= totalCount;
  const hasContent = totalCount > 0 || chapters.length > 0;

  // Land on the book itself when there is one. The wizard used to always mount at step 1
  // (upload), so coming back to a finished book meant clicking forward to find it again —
  // and, worse, step 2's preview iframe was mounted inside a `display: none` panel the
  // whole time, which is what made it come up blank (see `PhotoBookCreateStep`).
  //
  // Gated by the SAME predicate as `goToStep` below, not merely by `generatedAt`: a
  // generated book whose newly-added photos are still being analysed must not open on the
  // create step, or "Design again" would run over photos that have no vision scores yet
  // (and, in by-topic mode, land every one of them in the untagged leftover section).
  const [step, setStep] = useState(
    canAccessPhotoBookStep(1, analysisComplete, book.generatedAt, hasContent) ? 1 : 0,
  );

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
  // The same poll also carries the pass's current stage, which Step 2 renders as a live
  // checklist — a design pass runs for minutes, and an indefinite spinner reads as stuck.
  useEffect(() => {
    if (!book.designing) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/books/${book.id}/status`);
        if (!res.ok) return;
        const data = (await res.json()) as { designing: boolean; designStage: PhotoBookDesignStage | null };
        setDesignStage(data.designStage);
        if (!data.designing) router.refresh();
      } catch {
        /* transient network error — next tick retries */
      }
      // Faster than the other polls here: this one drives a progress display the user is
      // actively watching, and it's a single indexed row read.
    }, 2500);
    return () => clearInterval(timer);
  }, [book.designing, book.id, router]);

  // Server-rendered stage wins on every refresh; the poll above only fills the gaps between
  // them. Written during render (React's "adjusting state when a prop changes" pattern)
  // rather than in an effect, so the checklist never paints one stage behind.
  if (book.designStage !== serverStage) {
    setServerStage(book.designStage);
    setDesignStage(book.designStage);
  }

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

  /** The "Download PDF" button (docs/PHOTO_BOOK_PLAN.md PR5, the v1 deliverable, now
   *  living in step 3): if the book already has a fresh print PDF (`preview_ready` and
   *  not `layoutStale`), download it immediately. Otherwise trigger a render first
   *  (`renderPreviewAction` — the same action the order page's "prepare print proof"
   *  button calls, generalized in `lib/books.ts`'s `requestPreview` to cover photo books)
   *  and wait for it, so a book with a stale plan (photos added/excluded, a chat edit)
   *  never hands back an outdated PDF. */
  function downloadPdf() {
    if (isBookPrintFresh('unified', book.status, book.layoutStale)) {
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

  /** The config panel's title/subtitle/size/cover-type fields — one server round trip
   *  per saved field (each input saves independently on blur/change, same pattern as the
   *  story builder's settings card, `book-builder.tsx`). */
  function updateSettings(patch: {
    title?: string;
    subtitle?: string | null;
    format?: BookFormat;
    coverType?: BookCoverType;
  }) {
    startTransition(async () => {
      const result = await updatePhotoBookSettingsAction({ bookId: book.id, ...patch });
      if (result.error) {
        notifications.show({ message: result.error, color: 'red' });
        return;
      }
      router.refresh();
    });
  }

  /**
   * The config panel's "organise by" choice (`lib/photo-book-grouping.ts`). Whether saving
   * it also re-designs the book is decided SERVER-side, in `updatePhotoBookSettings` — the
   * rule ("re-sectioning needs a real design pass, unless the layout was hand-edited")
   * belongs with the mutation so every caller obeys it, not just this panel. All that's
   * left here is telling the user which of those happened.
   */
  function setGrouping(photoGrouping: PhotoBookGrouping) {
    if (photoGrouping === book.photoGrouping) return;
    // Ask first when the photos can't actually carry this grouping — "by place" with no GPS
    // produces one meaningless chapter, and on an already-generated book the switch spends
    // a whole design pass before the user could see that. The config panel only shows the
    // caveat for the grouping already chosen, so this is where it gets said in time.
    if (!groupingCoverage(photos, photoGrouping).sufficient) {
      setGroupingConfirm(photoGrouping);
      return;
    }
    applyGrouping(photoGrouping);
  }

  /** The caveat for the grouping awaiting confirmation — the same sentence the config panel
   *  shows once a grouping is chosen, said here BEFORE the switch commits. */
  const groupingConfirmMessage = (() => {
    if (!groupingConfirm) return null;
    const { supported, total } = groupingCoverage(photos, groupingConfirm);
    return groupingConfirm === 'location'
      ? tp.config.groupingWarnings.location(supported, total)
      : tp.config.groupingWarnings.topic(supported, total);
  })();

  function applyGrouping(photoGrouping: PhotoBookGrouping) {
    setGroupingConfirm(null);
    startTransition(async () => {
      const result = await updatePhotoBookSettingsAction({ bookId: book.id, photoGrouping });
      if (result.error) {
        notifications.show({ message: result.error, color: 'red' });
        return;
      }
      if (result.redesign === 'skipped-edited') {
        notifications.show({ message: tp.config.groupingNeedsRedesign, color: 'blue' });
      }
      router.refresh();
    });
  }

  /** The config panel's primary "Create book" / "Buch erstellen" CTA — the first design
   *  pass this book ever gets. Reuses the same AI design action the post-generation
   *  "Design again" affordance calls (`designBook` below); the only difference is WHEN
   *  the UI shows this button (gated on `book.generatedAt == null`, see
   *  `PhotoBookCreateStep`), not what it does. */
  function createBook() {
    designBook();
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
      // Wrapped in try/catch (unlike every other action call above, which only checks
      // `result.error`): a thrown exception here — not a handled `{ error }` result, an
      // actual rejection (a transient DB error, a session hiccup) — used to vanish into
      // React's transition machinery with no UI feedback at all: the eye toggle just
      // looked like it did nothing, no error shown either (the reported "re-include does
      // nothing" bug). Every other failure mode of this action already returns `{ error
      // }` and is handled below exactly as before; this only catches the case that
      // wasn't handled at all.
      try {
        const result = await setPhotoExcludedAction({ bookId: book.id, assetId, excluded });
        if (result.error) {
          notifications.show({ message: result.error, color: 'red' });
          return;
        }
        router.refresh();
      } catch {
        notifications.show({ message: tp.toggleExcludedFailed, color: 'red' });
      }
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
   *  `allowNextStepsSelect`, so the gating rule lives in one place (`analysisComplete`
   *  and, for step 3, `book.generatedAt`) instead of being split between this component
   *  and the Stepper's internal logic. The order step additionally requires the book to
   *  have been generated at least once — otherwise its "Download PDF" would silently
   *  build the plain auto-layout, bypassing the whole configure→generate flow (the same
   *  reason `PhotoBookOrderStep`'s own download button is also gated on `generatedAt`
   *  below, in case that step is ever reached some other way). */
  function goToStep(index: number) {
    if (!canAccessPhotoBookStep(index, analysisComplete, book.generatedAt, hasContent)) {
      // Mirrors `canAccessPhotoBookStep`'s own check order: analysis-incomplete is the
      // more fundamental blocker, so it wins the message even for step 2 (order) when
      // both conditions are unmet.
      const message = !hasContent
        ? tp.sources.needContent
        : !analysisComplete
          ? tp.waitingForAnalysis
          : tp.waitingForGeneration;
      notifications.show({ message, color: 'yellow' });
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
      {/* `allowNextStepsSelect` (Mantine, default true) is left at its default — it
          controls whether Mantine itself invokes `onStepClick` for a forward step; with it
          left on, EVERY step click (forward or backward) reaches `goToStep`, which is the
          single, fully-controlled gate (`analysisComplete`) described above. Explicitly
          setting it `false` would make Mantine silently swallow forward clicks itself,
          which would make `goToStep`'s own "finish analysis first" toast for the forward
          case unreachable dead code. */}
      <Stepper active={step} onStepClick={goToStep} mb="lg" keepMounted>
        <Stepper.Step label={tp.steps.upload} description={tp.stepUploadDescription}>
          <PhotoBookUploadStep
            bookId={book.id}
            photos={photos}
            chapters={chapters}
            chronicleStories={chronicleStories}
            hiddenChapterCount={hiddenChapterCount}
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
            // The Stepper keeps every step mounted (`keepMounted`), so the create step has
            // to know whether it is the VISIBLE one — its preview iframe must not load
            // inside a `display: none` panel (zero-size viewport → the injected
            // zoom-to-fit scales the page stack to nothing → blank preview).
            active={step === 1}
            designStage={designStage}
            photos={photos}
            locked={locked}
            pending={pending}
            onToggleExcluded={toggleExcluded}
            regenerating={regenerating}
            onRegenerate={regenerate}
            designPending={designPending}
            onCreateBook={createBook}
            onDesignBook={designBook}
            onSetStyle={setStyle}
            onSetGrouping={setGrouping}
            onUpdateSettings={updateSettings}
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
            generatedAt={book.generatedAt}
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
        opened={groupingConfirm != null}
        onClose={() => setGroupingConfirm(null)}
        title={tp.config.groupingConfirmTitle}
        centered
      >
        <Text size="sm">{groupingConfirmMessage}</Text>
        <Group justify="flex-end" mt="lg">
          <Button variant="default" onClick={() => setGroupingConfirm(null)} disabled={pending}>
            {t.common.cancel}
          </Button>
          <Button onClick={() => groupingConfirm && applyGrouping(groupingConfirm)} loading={pending}>
            {tp.config.groupingConfirmAnyway}
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
