/**
 * The stages a photo-book design pass moves through, and the little bit of logic the
 * builder needs to render them as a checklist.
 *
 * Why this exists: designing a book takes a couple of minutes (a vision call over dozens
 * of photos, a Chromium render of the draft, a second vision call to review it). A bare
 * spinner for that long reads as "stuck", so the worker writes its current stage to
 * `books.design_stage` as it goes, the status poll hands it to the client
 * (`app/api/books/[bookId]/status`), and Step 2 ticks stages off one by one.
 *
 * Pure and dependency-free on purpose: both the worker (which writes the column) and the
 * client component (which renders the checklist) import it, so it can't reach for `@/db`
 * or `@/lib/env`.
 */

export const PHOTO_BOOK_DESIGN_STAGES = [
  /** Loading the book's photos and picking which ones the model gets to actually see. */
  'preparing',
  /** The model is grouping photos into sections and laying out pages. */
  'drafting',
  /** Rendering the draft's pages so the model can look at its own work. */
  'proofing',
  /** The model is reviewing those rendered pages and fixing what doesn't work. */
  'reviewing',
  /** Checking the result over and saving it. */
  'finalizing',
] as const;

export type PhotoBookDesignStage = (typeof PHOTO_BOOK_DESIGN_STAGES)[number];

export function isPhotoBookDesignStage(value: unknown): value is PhotoBookDesignStage {
  return typeof value === 'string' && (PHOTO_BOOK_DESIGN_STAGES as readonly string[]).includes(value);
}

/** Narrows a raw `books.design_stage` value (an untyped text column) to a known stage,
 *  or `null` — a legacy/unknown value degrades to "no stage reported" rather than
 *  breaking the checklist. */
export function parseDesignStage(value: unknown): PhotoBookDesignStage | null {
  return isPhotoBookDesignStage(value) ? value : null;
}

/**
 * Where a stage sits in the checklist: everything before it is done, it is running, and
 * everything after is pending. An unknown/absent stage reports `-1`, which the UI renders
 * as "the first step is running" — a design pass is always at least preparing.
 */
export function designStageIndex(stage: PhotoBookDesignStage | null): number {
  return stage ? PHOTO_BOOK_DESIGN_STAGES.indexOf(stage) : -1;
}

/** How long a design pass may plausibly run before "still designing" stops being credible.
 *  A measured pass over 36 photos takes ~3.5 minutes (two vision calls with a Chromium
 *  render between them); this leaves generous room for a much bigger book. */
const DESIGN_STALE_AFTER_MS = 20 * 60 * 1000;

/**
 * Whether a design pass should still be presented as running.
 *
 * `books.design_requested_at` is cleared by the worker when the job finishes — but only if
 * the job finishes. A worker that dies mid-pass (OOM during the Chromium proof render, a
 * deploy restarting the container) leaves the flag set forever, and the builder then polls
 * a spinner that will never resolve: exactly the "is this stuck?" experience the progress
 * checklist exists to avoid, in its worst form. After this cutoff the book reports as not
 * designing, so the UI falls back to showing the book (or the "create" button to try
 * again) instead of waiting on a job that is never coming back.
 */
export function isDesignInFlight(designRequestedAt: Date | null, now: Date = new Date()): boolean {
  if (!designRequestedAt) return false;
  return now.getTime() - designRequestedAt.getTime() < DESIGN_STALE_AFTER_MS;
}
