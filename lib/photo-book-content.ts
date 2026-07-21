import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { assets, bookPhotos, books } from '@/db/schema';
import { getObjectBuffer } from '@/lib/s3';
import { orientedDimensions } from '@/lib/book-content';
import {
  checkPhotoBookPlanConsistency,
  validatePhotoBookPlan,
  type PhotoBookPlan,
  type PhotoPlanContent,
} from '@/lib/photo-book-plan';
import { buildPhotoBookAutoLayout, resolveUsableHeroId, type AutoLayoutPhoto } from '@/lib/photo-book-autolayout';
import { repairPhotoBookPlan } from '@/lib/photo-book-repair';
import { parsePhotoGrouping } from '@/lib/photo-book-grouping';
import { parseStoredPhotoAnalysis, type PhotoAnalysis } from '@/lib/photo-analysis';

/**
 * Photo-book content loading + layout-plan resolution — the photo-book counterpart of
 * `lib/book-content.ts`'s `loadBook`/`loadOrBuildPlan`/`buildAndPersistAutoPlan`, shared
 * by the web process's live preview (`app/api/books/[bookId]/preview-html/route.ts`) and
 * (from PR3 onward) the worker's AI design pass and print render. `lib/book-content.ts`
 * itself is untouched — story books keep exactly the functions they had.
 */

export interface PhotoBookPhotoRef {
  assetId: string;
  s3Key: string;
  thumbS3Key: string | null;
  /** ~1600px WebP (lib/thumbnails.ts) — used for full-page preview slots. Null until the
   *  worker's `thumbnail` job has run for this photo. */
  displayS3Key: string | null;
  mimeType: string;
  width: number | null;
  height: number | null;
  position: number;
  excluded: boolean;
  excludedReason: string | null;
  /** The user's own explicit include/exclude choice (`book_photos.user_decision`) —
   *  `null` means no explicit choice, auto-culling decides (docs/PHOTO_BOOK_PLAN.md
   *  re-include fix, see `lib/photo-book-autolayout.ts`'s module header). */
  userDecision: 'include' | 'exclude' | null;
  takenAt: Date | null;
  gpsLat: number | null;
  gpsLng: number | null;
  phash: string | null;
  blurScore: number | null;
  /** AI vision score (`lib/photo-analysis.ts`), re-validated against the schema on read
   *  (see `parseStoredPhotoAnalysis`) — `null` when the `photo-vision` pass hasn't
   *  completed for this photo yet, was never run, or (defensively) the stored jsonb
   *  doesn't validate. */
  analysis: PhotoAnalysis | null;
}

export interface LoadedPhotoBook {
  row: typeof books.$inferSelect;
  /** EVERY photo in the book, excluded or not — the builder's tray needs the excluded
   *  ones too, and `checkPhotoBookPlanConsistency` needs both sets to tell "excluded"
   *  apart from "not in this book at all". Plan resolution below filters this down to
   *  the available subset before handing it to the auto-layouter. */
  photos: PhotoBookPhotoRef[];
}

export async function loadPhotoBook(bookId: string): Promise<LoadedPhotoBook> {
  const [row] = await db.select().from(books).where(eq(books.id, bookId)).limit(1);
  if (!row) throw new Error(`Book ${bookId} not found`);
  if (row.kind !== 'photo') throw new Error(`Book ${bookId} is not a photo book`);

  const rows = await db
    .select({
      assetId: assets.id,
      s3Key: assets.s3Key,
      thumbS3Key: assets.thumbS3Key,
      displayS3Key: assets.displayS3Key,
      mimeType: assets.mimeType,
      width: assets.width,
      height: assets.height,
      position: bookPhotos.position,
      excluded: bookPhotos.excluded,
      excludedReason: bookPhotos.excludedReason,
      userDecision: bookPhotos.userDecision,
      takenAt: bookPhotos.takenAt,
      gpsLat: bookPhotos.gpsLat,
      gpsLng: bookPhotos.gpsLng,
      phash: bookPhotos.phash,
      blurScore: bookPhotos.blurScore,
      analysis: bookPhotos.analysis,
    })
    .from(bookPhotos)
    .innerJoin(assets, eq(bookPhotos.assetId, assets.id))
    .where(eq(bookPhotos.bookId, bookId))
    .orderBy(asc(bookPhotos.position));

  return {
    row,
    photos: rows.map((r) => ({
      ...r,
      userDecision: normalizeUserDecision(r.userDecision),
      analysis: parseStoredPhotoAnalysis(r.analysis),
    })),
  };
}

/** `book_photos.user_decision` is an untyped `text` column (like `excluded_reason`) — this
 *  narrows a stored value down to the two the app ever writes, so a stray/legacy value
 *  degrades to "no explicit choice" instead of typing as something the rest of the code
 *  never expects. */
function normalizeUserDecision(value: string | null): 'include' | 'exclude' | null {
  return value === 'include' || value === 'exclude' ? value : null;
}

/** A plan with no cover hero and no sections — used as a last-resort fallback if the
 *  auto-layouter (a pure function that should never produce an invalid plan) somehow
 *  did, so the preview route degrades to "blank photo book" instead of a 500. */
function emptyPlan(style: PhotoBookPlan['style'], title: string): PhotoBookPlan {
  return { kind: 'photo', style, cover: { title }, sections: [] };
}

/**
 * Loads the book's stored layout plan, or builds a fresh one with the deterministic
 * auto-layouter when there isn't one yet or it's stale — the photo-book counterpart of
 * `loadOrBuildPlan` in `lib/book-content.ts`. Same trust model: a non-stale stored plan
 * is only re-validated against the SCHEMA, not re-checked against current content —
 * `books.layout_stale` is the single source of truth for "does this plan still match
 * what's in the book", flipped by every mutation that changes the available photo set
 * (`lib/books.ts`'s `setPhotoExcluded`/`addBookPhotos`).
 */
export async function loadOrBuildPhotoPlan(bookId: string, loaded: LoadedPhotoBook): Promise<PhotoBookPlan> {
  const { row } = loaded;

  if (row.layoutPlan && !row.layoutStale) {
    const validated = validatePhotoBookPlan(row.layoutPlan);
    if (validated.ok) return validated.plan;
    console.warn(
      `[photo-book-content] stored plan for ${bookId} failed validation, rebuilding:`,
      validated.error,
    );
  } else if (row.layoutPlan && row.layoutStale && row.layoutSource !== 'auto') {
    const repaired = await repairAndPersistPhotoPlan(bookId, loaded);
    if (repaired) return repaired;
  }

  return buildAndPersistPhotoAutoPlan(bookId, loaded);
}

/**
 * Brings an AI-designed or hand-edited plan back in line with the book's current photos,
 * rather than throwing it away and regenerating from scratch.
 *
 * This is the fix for the worst behaviour photo books had: excluding a single photo (or
 * adding one) flips `layout_stale`, and the very next page load — a plain GET, in the web
 * process — used to run the deterministic auto-layouter over the book and persist the
 * result as `layout_source: 'auto'`. The user's AI-designed book was silently replaced by
 * the mechanical date-range layout, for good, by looking at it. `repairPhotoBookPlan`
 * (`lib/photo-book-repair.ts`) instead drops what can no longer be shown, re-fits the pages
 * that lost a photo, and keeps the sections, titles, pacing and cover the design pass chose.
 *
 * Returns `null` when the repair leaves nothing worth keeping (every photo gone), so the
 * caller falls back to a full auto rebuild.
 *
 * Note what this deliberately does NOT do: place photos that were added since the plan was
 * built. A plan's producer is allowed to leave a photo out on purpose, and nothing in the
 * data distinguishes "the designer passed on this one" from "this one is new" — so folding
 * new photos in automatically would resurrect every photo the design dropped, every time
 * anything went stale. Newly uploaded photos reach the book through an explicit "Design
 * again"/regenerate instead.
 */
async function repairAndPersistPhotoPlan(
  bookId: string,
  loaded: LoadedPhotoBook,
): Promise<PhotoBookPlan | null> {
  const stored = validatePhotoBookPlan(loaded.row.layoutPlan);
  if (!stored.ok) return null;

  const available = loaded.photos.filter(
    (p): p is PhotoBookPhotoRef & { width: number; height: number } =>
      !p.excluded && p.width != null && p.height != null,
  );
  if (available.length === 0) return null;

  const { plan, changes } = repairPhotoBookPlan(stored.plan, {
    photos: available.map((p) => ({ assetId: p.assetId, width: p.width, height: p.height, analysis: p.analysis })),
    mustInclude: available.filter((p) => p.userDecision === 'include').map((p) => p.assetId),
  });

  const content: PhotoPlanContent = {
    availableAssetIds: loaded.photos.filter((p) => !p.excluded).map((p) => p.assetId),
    allAssetIds: loaded.photos.map((p) => p.assetId),
  };
  const revalidated = validatePhotoBookPlan(plan);
  const problems = revalidated.ok ? checkPhotoBookPlanConsistency(revalidated.plan, content) : [revalidated.error];
  if (!revalidated.ok || problems.length > 0) {
    console.warn(`[photo-book-content] could not repair the stored plan for ${bookId}, rebuilding:`, problems);
    return null;
  }
  // Nothing left to show — a full rebuild will produce the same emptiness more honestly.
  if (revalidated.plan.sections.length === 0) return null;

  if (changes.length > 0) {
    console.log(`[photo-book-content] repaired the ${loaded.row.layoutSource} plan for ${bookId}:`, changes);
  }
  // `layoutSource` is deliberately left alone: this is the same design, adjusted — not a
  // new one. Keeping it as 'ai'/'edited' also keeps the builder's "replace your manual
  // edits?" consent prompt honest.
  await db
    .update(books)
    .set({ layoutPlan: revalidated.plan, layoutStale: false, updatedAt: new Date() })
    .where(eq(books.id, bookId));
  return revalidated.plan;
}

/**
 * Always rebuilds the plan with the deterministic auto-layouter and persists it as
 * `layout_source: 'auto'`, regardless of any existing plan/staleness — the explicit
 * "regenerate" path, mirroring `buildAndPersistAutoPlan` in `lib/book-content.ts`.
 *
 * Two things happen here that the story path doesn't need:
 *  1. Photos the layouter culled (near-duplicate/blurry, see
 *     `lib/photo-book-autolayout.ts`'s header comment) are written to
 *     `book_photos.excluded`/`excluded_reason` — the pure layouter only REPORTS them,
 *     this is the "thin persistence wrapper" that actually applies it, so the builder's
 *     tray shows them and a user can tap to re-include.
 *  2. The freshly-built plan is validated + consistency-checked before being persisted
 *     (docs/PHOTO_BOOK_PLAN.md PR2 scope explicitly asks for this as a safety net) — the
 *     auto-layouter is a pure function that should never produce a bad plan, but this
 *     runs in the web request path (the live preview), so a bug here degrades to an
 *     empty-but-valid plan instead of a 500.
 *
 * Cover title/subtitle are NOT carried over from a prior plan (unlike style and cover
 * hero, which are — see the story path's carry-over rule): since PR6 (the builder Step 2
 * config panel) both are explicit, book-level settings (`books.title`/`books.subtitle`)
 * the user edits directly, so this always tracks their CURRENT value rather than freezing
 * whatever the cover happened to say on a previous build — the same behavior a story
 * book's cover already has (its title/subtitle are book-level fields read fresh on every
 * render, never stored in the plan at all). `lib/books.ts`'s `updatePhotoBookSettings`
 * additionally patches an already-stored plan's cover in place on a title/subtitle edit,
 * so a change is visible immediately without waiting for the next full rebuild this
 * function does.
 */
export async function buildAndPersistPhotoAutoPlan(
  bookId: string,
  loaded: LoadedPhotoBook,
): Promise<PhotoBookPlan> {
  const { row } = loaded;

  const available = loaded.photos.filter((p) => !p.excluded);
  const autoLayoutPhotos: AutoLayoutPhoto[] = available
    .filter((p): p is PhotoBookPhotoRef & { width: number; height: number } => p.width != null && p.height != null)
    .map((p) => ({
      assetId: p.assetId,
      width: p.width,
      height: p.height,
      position: p.position,
      takenAt: p.takenAt,
      gpsLat: p.gpsLat,
      gpsLng: p.gpsLng,
      phash: p.phash,
      blurScore: p.blurScore,
      analysis: p.analysis,
      userDecision: p.userDecision,
    }));

  const existing = row.layoutPlan ? validatePhotoBookPlan(row.layoutPlan) : null;
  const existingPlan = existing?.ok ? existing.plan : null;

  // A pinned (`row.coverAssetId`) or carried-over (`existingPlan.cover.heroAssetId`) hero
  // must be dropped here if it's no longer present-and-non-excluded, via
  // `resolveUsableHeroId` — see that function's doc comment for why (PR3 FIX 1b: a stale
  // hero id passed through unfiltered makes `buildPhotoBookAutoLayout` echo it straight to
  // `plan.cover.heroAssetId`, which then fails consistency and blanks the WHOLE plan, not
  // just the cover). Mirrors the guard `applyPhotoPlanCarryOver`
  // (`lib/photo-book-ai-layout.ts`) already applies to the AI path.
  const coverAssetId = resolveUsableHeroId(row.coverAssetId, available);
  const existingHeroAssetId = resolveUsableHeroId(existingPlan?.cover.heroAssetId, available) ?? undefined;

  const { plan: built, culled } = buildPhotoBookAutoLayout({
    title: row.title,
    subtitle: row.subtitle,
    coverAssetId,
    existingStyle: existingPlan?.style,
    existingHeroAssetId,
    grouping: parsePhotoGrouping(row.photoGrouping),
    photos: autoLayoutPhotos,
  });

  if (culled.length > 0) {
    const byReason = new Map<string, string[]>();
    for (const c of culled) {
      const ids = byReason.get(c.reason) ?? [];
      ids.push(c.assetId);
      byReason.set(c.reason, ids);
    }
    for (const [reason, assetIds] of byReason) {
      await db
        .update(bookPhotos)
        .set({ excluded: true, excludedReason: reason, updatedAt: new Date() })
        .where(and(eq(bookPhotos.bookId, bookId), inArray(bookPhotos.assetId, assetIds)));
    }
  }

  const culledIds = new Set(culled.map((c) => c.assetId));
  const content: PhotoPlanContent = {
    availableAssetIds: available.map((p) => p.assetId).filter((id) => !culledIds.has(id)),
    allAssetIds: loaded.photos.map((p) => p.assetId),
  };

  const validated = validatePhotoBookPlan(built);
  const problems = validated.ok ? checkPhotoBookPlanConsistency(validated.plan, content) : [validated.error];
  const plan = validated.ok && problems.length === 0 ? validated.plan : emptyPlan(built.style, row.title);
  if (!validated.ok || problems.length > 0) {
    console.error(
      `[photo-book-content] auto-layouter produced an invalid/inconsistent plan for ${bookId}, falling back to empty:`,
      problems,
    );
  }

  await db
    .update(books)
    .set({ layoutPlan: plan, layoutSource: 'auto', layoutStale: false, updatedAt: new Date() })
    .where(eq(books.id, bookId));

  return plan;
}

/** Every assetId a plan actually renders — cover hero, cover back photos, and every
 *  section page's photos. Mirrors `referencedAssetIds` in `lib/book-content.ts`. */
export function referencedPhotoAssetIds(plan: PhotoBookPlan): Set<string> {
  const ids = new Set<string>();
  if (plan.cover.heroAssetId) ids.add(plan.cover.heroAssetId);
  for (const id of plan.cover.backAssetIds ?? []) ids.add(id);
  for (const section of plan.sections) {
    for (const page of section.pages) {
      for (const id of page.assetIds) ids.add(id);
    }
  }
  return ids;
}

/** Which single-photo templates render full-page — these want the ~1600px "display"
 *  rendition (docs/PHOTO_BOOK_PLAN.md §8); every other placement (multi-photo grids,
 *  the small back-cover photos) is fine at the 640px thumbnail. */
const DISPLAY_QUALITY_TEMPLATES = new Set(['full-bleed', 'full-framed', 'divider']);

/** For every photo the plan places, whether the preview should presign its `display`
 *  rendition (falling back to the thumbnail/original) or the smaller thumbnail. A photo
 *  placed in more than one role (unusual — `checkPhotoBookPlanConsistency` normally
 *  forbids reusing a photo, but the cover hero always gets display quality regardless of
 *  where else a bug might reference it) resolves to `'display'` if ANY placement wants it. */
export function photoAssetRenditionNeeds(plan: PhotoBookPlan): Map<string, 'display' | 'thumb'> {
  const needs = new Map<string, 'display' | 'thumb'>();
  function want(id: string, level: 'display' | 'thumb') {
    if (needs.get(id) === 'display') return;
    needs.set(id, level);
  }
  if (plan.cover.heroAssetId) want(plan.cover.heroAssetId, 'display');
  for (const id of plan.cover.backAssetIds ?? []) want(id, 'thumb');
  for (const section of plan.sections) {
    for (const page of section.pages) {
      const level = DISPLAY_QUALITY_TEMPLATES.has(page.template) ? 'display' : 'thumb';
      for (const id of page.assetIds) want(id, level);
    }
  }
  return needs;
}

/**
 * Fills in `assets.width/height` for any book photo missing them, reading the true
 * original from S3 — the photo-book counterpart of `backfillDimensionsFromOriginals` in
 * `lib/book-content.ts`. In practice every book photo already has dimensions by the time
 * a plan is built (the `photo-meta` job sets them right after upload — `lib/photo-meta.ts`),
 * so this is a defensive backfill for the render path, same reasoning as the story path:
 * an older/failed upload shouldn't silently drop out of the printed book for lack of a
 * dimension. Worker-only, like its story counterpart — it's the one process allowed to
 * write `assets.width/height`. Mutates `photos` in place so the caller's in-memory copy
 * (already loaded for the plan build) reflects the backfilled values without a re-fetch.
 */
export async function backfillPhotoBookDimensionsFromOriginals(
  photos: PhotoBookPhotoRef[],
): Promise<void> {
  for (const photo of photos) {
    if (photo.width && photo.height) continue;
    try {
      const buffer = await getObjectBuffer(photo.s3Key);
      const dims = await orientedDimensions(buffer);
      if (!dims) continue;
      photo.width = dims.width;
      photo.height = dims.height;
      await db.update(assets).set({ width: dims.width, height: dims.height }).where(eq(assets.id, photo.assetId));
    } catch (e) {
      console.error(`[photo-book-content] failed to read original dimensions for ${photo.s3Key}:`, e);
    }
  }
}

// `countPhotoBookPages` and `photoAssetPrintTargetSizeMm` (page-count estimation and
// print-embedding size math) live in `lib/photo-book-print-sizing.ts`, NOT here — they're
// pure functions with no DB/S3 dependency, and this file's other exports (`loadPhotoBook`
// etc.) pull in `@/db`/`@/lib/s3` at module scope, which would drag a database/env
// dependency into what should be a plain, vitest-without-a-database unit test. Re-exported
// here anyway so existing callers of this module don't need a second import.
export { countPhotoBookPages, photoAssetPrintTargetSizeMm, type PrintTargetSizeMm } from '@/lib/photo-book-print-sizing';
