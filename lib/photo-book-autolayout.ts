import { hammingDistance } from '@/lib/photo-hash';
import { DEFAULT_PHOTO_BOOK_GROUPING, type PhotoBookGrouping } from '@/lib/photo-book-grouping';
import type { PhotoAnalysis } from '@/lib/photo-analysis';
import {
  photoOrientation,
  type PhotoBookPlan,
  type PhotoBookStyle,
  type PhotoPagePlan,
  type PhotoSectionPlan,
} from '@/lib/photo-book-plan';

/**
 * The photo-book deterministic auto-layouter (docs/PHOTO_BOOK_PLAN.md §6, producer #1) —
 * the photo-book counterpart of `lib/book-autolayout.ts`. Pure function: no I/O, no
 * randomness, same input always produces the same plan. Runs the instant a book's photos
 * have their *metadata* analyzed (`photo-meta`, PR1), and keeps working exactly as it did
 * in PR2 for any photo without a vision score yet — `analysis` (`PhotoAnalysis`, from
 * PR3's `photo-vision` job, `lib/photo-analysis.ts`) is an OPTIONAL, purely additive
 * input on `AutoLayoutPhoto`: every heuristic below that reads it falls back to its PR2,
 * dimension/phash/blurScore-only behavior whenever it's absent, so a book whose vision
 * pass hasn't finished (or was never run) lays out identically to before. Only pure
 * function additions — no I/O here either, `analysis` arrives already-loaded on each
 * `AutoLayoutPhoto` the same way `takenAt`/`phash`/`blurScore` do.
 *
 * Culling (near-duplicates, clearly-blurry photos, and — when scores are present —
 * eyes-closed and low-aesthetic surplus photos) is computed here but NOT applied to
 * the database by this function — it only *reports* what it chose to omit and why. A
 * thin persistence wrapper (`lib/photo-book-content.ts`'s `buildAndPersistPhotoAutoPlan`)
 * writes those into `book_photos.excluded`/`excluded_reason` so the builder's tray can
 * show them and the user can override. This keeps the layouter pure (like
 * `buildLayoutPlan`) while still giving the "excluded ≠ deleted, one tap to re-include"
 * UX the plan calls for — and once persisted, an omitted photo is `excluded = true` in
 * the DB, so the NEXT call to this function (fed only `book_photos.excluded = false`
 * rows by the loader) never sees it again.
 *
 * A user's manual re-include is NOT just "excluded = false" though — without a separate
 * marker, the very next rebuild would run this photo back through the same cullers that
 * excluded it in the first place (still a duplicate, still blurry) and silently exclude it
 * again, which is exactly the bug `userDecision` fixes: `book_photos.user_decision` records
 * the user's OWN choice, independent of `excluded`, and a photo with `userDecision:
 * 'include'` (see `AutoLayoutPhoto.userDecision`) is immune to every culler below no matter
 * what its scores/hashes say — "the user insisted" always wins. A photo with `userDecision:
 * 'exclude'` is dropped before culling even runs (it isn't a *cull*, the user already
 * decided) and never resurfaces on its own. Only photos with no explicit decision
 * (`userDecision` unset) are subject to automatic culling, exactly as before.
 */

export interface AutoLayoutPhoto {
  assetId: string;
  /** Pixel dimensions after EXIF-orientation correction — both required, same contract
   *  as `AutoLayoutImage` in `lib/book-autolayout.ts`. */
  width: number;
  height: number;
  /** Upload order — the fallback sort key for photos with no `takenAt` (they're grouped
   *  into one trailing section in upload order, never interleaved into the dated
   *  sections — see the module header and `splitByCaptureTime` below). */
  position: number;
  takenAt: Date | null;
  gpsLat: number | null;
  gpsLng: number | null;
  /** dHash, hex — near-duplicate clustering. Photos without one are never treated as
   *  duplicates of anything (nothing to compare). */
  phash: string | null;
  /** Variance-of-Laplacian; lower = blurrier. Photos without one are never blur-culled. */
  blurScore: number | null;
  /** AI vision score (PR3, `lib/photo-analysis.ts`) — `undefined`/`null` for a photo
   *  whose `photo-vision` pass hasn't completed (or was never run). Every heuristic that
   *  reads this treats its absence as "no opinion", not as a bad score — see the module
   *  header comment. */
  analysis?: PhotoAnalysis | null;
  /** The user's own explicit include/exclude choice (`book_photos.user_decision`),
   *  independent of everything else here — `undefined`/`null` means "no explicit choice,
   *  auto-culling decides" (the PR2/PR3 behavior, unchanged). `'include'` makes a photo
   *  IMMUNE to every culler below (duplicate/blurry/eyes-closed/low-quality) — the user
   *  explicitly asked for it back, so it must survive a rebuild even if it would
   *  otherwise be culled again. `'exclude'` is filtered out before culling even runs (see
   *  `buildPhotoBookAutoLayout`) — defense in depth, since a force-excluded photo should
   *  already have `excluded = true` and never reach this input at all (the loader only
   *  ever passes `excluded = false` rows — see `buildAndPersistPhotoAutoPlan`). */
  userDecision?: 'include' | 'exclude' | null;
}

/** True when the user has explicitly pinned this photo IN — it must survive every
 *  culler below no matter what its scores/hashes say. */
function isForceIncluded(p: AutoLayoutPhoto): boolean {
  return p.userDecision === 'include';
}

export interface PhotoBookAutoLayoutInput {
  /** The book's title — the cover's default title when nothing has overridden it. */
  title: string;
  /** The book's current subtitle (`books.subtitle`, PR6's config panel "Untertitel"
   *  field) — threaded onto the cover fresh on every build, same "book settings win"
   *  reasoning as `title` (see `buildAndPersistPhotoAutoPlan`'s doc comment for why the
   *  cover title/subtitle are never carried over from a stale prior plan instead). */
  subtitle?: string | null;
  /** The book's explicit cover pin (`books.cover_asset_id`), if any — always wins as the
   *  hero, same precedence as `AutoLayoutInput.coverAssetId` in `lib/book-autolayout.ts`. */
  coverAssetId: string | null;
  /** Choices carried over from a previous plan (auto, AI, or edited) so a content-only
   *  regeneration never silently resets a design choice — §6 phase 4's carry-over rule,
   *  mirrored from `lib/book-autolayout.ts`'s `existingTheme`/`existingCoverStyle`. */
  existingStyle?: PhotoBookStyle;
  existingHeroAssetId?: string;
  existingCoverTitle?: string;
  existingCoverSubtitle?: string | null;
  /** BCP-47 tag for "Juni 2025"-style date-range section titles (`Intl.DateTimeFormat`).
   *  Defaults to `'de-DE'` — the same hardcoded default `lib/book-render.ts` uses for its
   *  print colophon's `createdLabel`, matching the app's German-first default locale
   *  (`DEFAULT_LOCALE` in `lib/i18n/config.ts`) until a book carries its chronicle's
   *  language through here. */
  dateLocale?: string;
  /** Title for the trailing section holding photos with no capture time at all.
   *  Defaults to a German label, same reasoning as `dateLocale`. */
  undatedSectionTitle?: string;
  /** How the user asked for this book to be organised (`books.photo_grouping`, see
   *  `lib/photo-book-grouping.ts`). Defaults to chronological — what every book did before
   *  the setting existed. */
  grouping?: PhotoBookGrouping;
  /** Every photo currently AVAILABLE to the layout — i.e. `book_photos.excluded = false`
   *  (a user's own exclusions are never second-guessed here; see the module header). */
  photos: AutoLayoutPhoto[];
}

export interface CulledPhoto {
  assetId: string;
  /** Matches `book_photos.excluded_reason`'s documented values (docs/PHOTO_BOOK_PLAN.md
   *  §2) — `'eyes-closed'`/`'low-quality'` only ever fire when `analysis` is present. */
  reason: 'duplicate' | 'blurry' | 'eyes-closed' | 'low-quality';
}

/** The auto-layouter never emits text runs — its sections hold photo pages only
 *  (story-aware layout arrives with the unified loader). Narrowed types keep that
 *  guarantee visible to callers and tests; both are assignable to their wide
 *  counterparts (`PhotoSectionPlan`/`PhotoBookPlan`). */
export type PhotoOnlySectionPlan = Omit<PhotoSectionPlan, 'pages'> & { pages: PhotoPagePlan[] };
export type PhotoOnlyBookPlan = Omit<PhotoBookPlan, 'sections'> & { sections: PhotoOnlySectionPlan[] };

export interface PhotoBookAutoLayoutResult {
  plan: PhotoOnlyBookPlan;
  /** Photos the layouter chose to leave out of the plan, with why — NOT yet persisted;
   *  see the module header. */
  culled: CulledPhoto[];
}

/** A time gap bigger than this starts a new section — long enough that a day's outings
 *  (breakfast, an afternoon walk, dinner) stay together, short enough that "yesterday
 *  evening" and "this morning" split, while a genuine weekend trip (photos most hours of
 *  each day, gaps only overnight) still reads as one section because no single gap in it
 *  exceeds this threshold. */
const SECTION_GAP_MS = 8 * 60 * 60 * 1000;

/** A jump further than this between two chronologically adjacent photos starts a new
 *  section even if the time gap alone wouldn't (e.g. a short flight/drive). */
const GPS_JUMP_KM = 50;

/** A section smaller than this gets folded into a neighbor — a lone photo or two doesn't
 *  carry its own chapter. */
const MIN_SECTION_SIZE = 3;

/** Roughly this many photos per section is the target when capping section count for a
 *  book's size (docs/PHOTO_BOOK_PLAN.md §6: "cap section count relative to book size") —
 *  a 24-photo book tops out around 3 sections, a 240-photo book around 30. */
const SECTION_CAP_DIVISOR = 8;

/** dHash is a 64-bit fingerprint (8x8 comparison grid); ≤ this many differing bits reads
 *  as "visually the same shot" (burst-mode duplicates, near-identical retakes). */
const DUP_HAMMING_THRESHOLD = 6;

/** A photo whose blurScore is below this fraction of its cluster's SHARPEST sibling is
 *  "clearly blurry" relative to what's actually available — relative, not an absolute
 *  cutoff, because `computeBlurScore`'s variance-of-Laplacian scale depends on image
 *  content/contrast, not just focus. */
const BLUR_RELATIVE_THRESHOLD = 0.12;

/** Never blur-cull a section (or the whole book, for cover-picking) down to zero. */
const MIN_SURVIVORS = 1;

/** Aspect-ratio classification driving template choice (docs/PHOTO_BOOK_PLAN.md §6 pacing)
 *  — the one shared definition, see `photoOrientation` in `lib/photo-book-plan.ts`. */
const classify = photoOrientation;

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Splits into time-sorted dated photos and position-sorted undated photos. Undated
 *  photos never interleave with dated ones (there's no sound way to place them
 *  chronologically) — they become one trailing section in upload order instead. */
function splitByCaptureTime(photos: AutoLayoutPhoto[]): { dated: AutoLayoutPhoto[]; undated: AutoLayoutPhoto[] } {
  const dated = photos
    .filter((p) => p.takenAt != null)
    .slice()
    .sort((a, b) => a.takenAt!.getTime() - b.takenAt!.getTime() || a.position - b.position);
  const undated = photos
    .filter((p) => p.takenAt == null)
    .slice()
    .sort((a, b) => a.position - b.position);
  return { dated, undated };
}

/** Splits time-sorted photos into sections wherever a time/GPS boundary fires. */
function sectionizeByBoundary(sortedDated: AutoLayoutPhoto[]): AutoLayoutPhoto[][] {
  if (sortedDated.length === 0) return [];
  const sections: AutoLayoutPhoto[][] = [[sortedDated[0]]];
  for (let i = 1; i < sortedDated.length; i++) {
    const prev = sortedDated[i - 1];
    const cur = sortedDated[i];
    let boundary = cur.takenAt!.getTime() - prev.takenAt!.getTime() > SECTION_GAP_MS;
    if (!boundary && prev.gpsLat != null && prev.gpsLng != null && cur.gpsLat != null && cur.gpsLng != null) {
      boundary = haversineKm(prev.gpsLat, prev.gpsLng, cur.gpsLat, cur.gpsLng) > GPS_JUMP_KM;
    }
    if (boundary) sections.push([cur]);
    else sections[sections.length - 1].push(cur);
  }
  return sections;
}

/** Time gap between the end of one photo group and the start of the next — used to pick
 *  which adjacent pair to merge, both for tiny-section folding and section-count
 *  capping. The undated tail has no `takenAt` on its boundary photos, so it falls back to
 *  the epoch (1970) on whichever side is undated; measured against a real (modern) date on
 *  the other side, that reads as a HUGE gap — decades, not zero — which is exactly what
 *  sorts it last among merge candidates (this function picks the *smallest* gap first): it
 *  only gets merged once every other, genuinely-close pair has already been merged. */
function gapBetween(a: AutoLayoutPhoto[], b: AutoLayoutPhoto[]): number {
  const aEnd = a[a.length - 1]?.takenAt?.getTime() ?? 0;
  const bStart = b[0]?.takenAt?.getTime() ?? 0;
  return Math.abs(bStart - aEnd);
}

/** Folds any section under `MIN_SECTION_SIZE` into whichever neighbor it's chronologically
 *  closer to, repeating until every remaining section clears the floor (or only one
 *  section is left). */
function mergeTinySections(sections: AutoLayoutPhoto[][]): AutoLayoutPhoto[][] {
  const out = sections.map((s) => s.slice());
  let changed = true;
  while (changed && out.length > 1) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      if (out[i].length >= MIN_SECTION_SIZE) continue;
      const hasNext = i < out.length - 1;
      const hasPrev = i > 0;
      if (!hasNext && !hasPrev) continue;
      const mergeIntoNext =
        hasNext && (!hasPrev || gapBetween(out[i], out[i + 1]) <= gapBetween(out[i - 1], out[i]));
      if (mergeIntoNext) {
        out[i] = [...out[i], ...out[i + 1]];
        out.splice(i + 1, 1);
      } else {
        out[i - 1] = [...out[i - 1], ...out[i]];
        out.splice(i, 1);
      }
      changed = true;
      break; // structure changed — restart the scan
    }
  }
  return out;
}

/** Merges the chronologically-closest adjacent pair, repeatedly, until section count is
 *  at or under the size-proportional cap. */
function capSectionCount(sections: AutoLayoutPhoto[][]): AutoLayoutPhoto[][] {
  const total = sections.reduce((n, s) => n + s.length, 0);
  const maxSections = Math.max(1, Math.ceil(total / SECTION_CAP_DIVISOR));
  const out = sections.map((s) => s.slice());
  while (out.length > maxSections && out.length > 1) {
    let bestIdx = 0;
    let bestGap = Infinity;
    for (let i = 0; i < out.length - 1; i++) {
      const gap = gapBetween(out[i], out[i + 1]);
      if (gap < bestGap) {
        bestGap = gap;
        bestIdx = i;
      }
    }
    out[bestIdx] = [...out[bestIdx], ...out[bestIdx + 1]];
    out.splice(bestIdx + 1, 1);
  }
  return out;
}

function monthYear(d: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
}

/** "Juni 2025" for a single-month section, "Juni – August 2025" / "Dezember 2024 –
 *  Januar 2025" for one spanning months (docs/PHOTO_BOOK_PLAN.md §4: "v1 groups by GPS
 *  proximity/time without naming places — no geocoding dependency"). */
function dateRangeLabel(min: Date, max: Date, locale: string): string {
  const sameMonth = min.getUTCFullYear() === max.getUTCFullYear() && min.getUTCMonth() === max.getUTCMonth();
  if (sameMonth) return monthYear(min, locale);
  const sameYear = min.getUTCFullYear() === max.getUTCFullYear();
  if (sameYear) {
    const startMonth = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }).format(min);
    return `${startMonth} – ${monthYear(max, locale)}`;
  }
  return `${monthYear(min, locale)} – ${monthYear(max, locale)}`;
}

function sectionTitle(
  photos: AutoLayoutPhoto[],
  locale: string,
  undatedTitle: string,
  grouping: PhotoBookGrouping = DEFAULT_PHOTO_BOOK_GROUPING,
): string {
  // A by-topic section is defined by what it shows, so a date range would actively
  // mislabel it — name it after its most common scene tag instead. Those tags come out of
  // the vision pass in English (`lib/photo-vision.ts`), which is the accepted cost of a
  // fallback title: the AI design pass is the normal producer here and writes titles in the
  // chronicle's own language. Location sections keep a date-range label — v1 has no
  // reverse geocoding (docs/PHOTO_BOOK_PLAN.md §4), and "48.14, 11.58" is worse than a
  // date.
  if (grouping === 'topic') {
    const counts = new Map<string, number>();
    for (const photo of photos) {
      for (const tag of new Set(tagsOf(photo))) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (top) return top[0].replace(/(^|\s)\S/g, (c) => c.toUpperCase());
  }
  const times = photos.filter((p) => p.takenAt != null).map((p) => p.takenAt!.getTime());
  if (times.length === 0) return undatedTitle;
  return dateRangeLabel(new Date(Math.min(...times)), new Date(Math.max(...times)), locale);
}

/** Groups near-duplicate photos (dHash Hamming distance <= threshold) within one section
 *  and keeps only the sharpest of each cluster. Greedy single-link clustering — not a
 *  strict transitive closure (a long chain of gradually-drifting near-matches could group
 *  photos whose ends aren't themselves close), which is an accepted simplification for a
 *  cheap, deterministic pass; PR3's vision vote can refine this later. */
function cullDuplicates(photos: AutoLayoutPhoto[]): { keep: AutoLayoutPhoto[]; culled: CulledPhoto[] } {
  const withHash = photos.filter((p) => p.phash != null);
  const assigned = new Set<string>();
  const culledIds = new Set<string>();
  const culled: CulledPhoto[] = [];

  for (const p of withHash) {
    if (assigned.has(p.assetId)) continue;
    const cluster = [p];
    assigned.add(p.assetId);
    for (const q of withHash) {
      if (assigned.has(q.assetId)) continue;
      if (hammingDistance(p.phash!, q.phash!) <= DUP_HAMMING_THRESHOLD) {
        cluster.push(q);
        assigned.add(q.assetId);
      }
    }
    if (cluster.length <= 1) continue;
    const sorted = cluster
      .slice()
      .sort((a, b) => (b.blurScore ?? -Infinity) - (a.blurScore ?? -Infinity) || a.position - b.position);
    for (const loser of sorted.slice(1)) {
      // A force-included loser stays — the user insisted on this exact photo, duplicate
      // or not (docs/PHOTO_BOOK_PLAN.md re-include fix). The cluster's winner is
      // unaffected either way, so this can leave both in the book, which is correct.
      if (isForceIncluded(loser)) continue;
      culledIds.add(loser.assetId);
      culled.push({ assetId: loser.assetId, reason: 'duplicate' });
    }
  }

  return { keep: photos.filter((p) => !culledIds.has(p.assetId)), culled };
}

/** Culls clearly-blurry photos relative to their section's sharpest survivor, never
 *  culling the section down below `MIN_SURVIVORS`. */
function cullBlurry(photos: AutoLayoutPhoto[]): { keep: AutoLayoutPhoto[]; culled: CulledPhoto[] } {
  const scored = photos.filter((p) => p.blurScore != null);
  if (scored.length === 0) return { keep: photos, culled: [] };
  const maxBlur = Math.max(...scored.map((p) => p.blurScore!));
  if (maxBlur <= 0) return { keep: photos, culled: [] };

  const culled: CulledPhoto[] = [];
  const culledIds = new Set<string>();
  let survivorCount = photos.length;
  for (const p of photos) {
    if (p.blurScore == null) continue;
    if (survivorCount <= MIN_SURVIVORS) break;
    if (isForceIncluded(p)) continue;
    if (p.blurScore < maxBlur * BLUR_RELATIVE_THRESHOLD) {
      culledIds.add(p.assetId);
      culled.push({ assetId: p.assetId, reason: 'blurry' });
      survivorCount--;
    }
  }
  return { keep: photos.filter((p) => !culledIds.has(p.assetId)), culled };
}

/**
 * Culls eyes-closed photos (docs/PHOTO_BOOK_PLAN.md §6: "eyesClosed on photos with a
 * sharp-eyed sibling in the same time cluster") — a no-op whenever no photo in the group
 * has an `analysis` at all (PR2 behavior, unscored books/photos untouched), and whenever
 * NONE of the group's analyzed photos has its eyes open (culling every eyes-closed shot
 * with nothing to replace it with would just remove the only record of that moment).
 * Bounded by `MIN_SURVIVORS`, same floor as `cullBlurry`. `protectedId` (the pinned or
 * carried-over cover hero — see `buildPhotoBookAutoLayout`) is NEVER culled here even if
 * it scores `eyesClosed: true`: the hero is resolved from `input.coverAssetId` /
 * `input.existingHeroAssetId` independently of anything this function decides, so
 * culling it anyway would leave `plan.cover.heroAssetId` pointing at an excluded photo —
 * `checkPhotoBookPlanConsistency` flags that as "Cover references an excluded photo" and
 * the whole plan gets discarded for a blank one (see the module's PR3 fix history). A
 * user's own explicit pin — or a hero the book has already settled on across a rebuild —
 * always wins over this heuristic; the alternative (a blank book) is strictly worse than
 * a cover with closed eyes the user chose.
 */
function cullEyesClosed(
  photos: AutoLayoutPhoto[],
  protectedId: string | null,
): { keep: AutoLayoutPhoto[]; culled: CulledPhoto[] } {
  const analyzed = photos.filter((p) => p.analysis != null);
  if (analyzed.length === 0) return { keep: photos, culled: [] };
  const hasOpenEyedSibling = analyzed.some((p) => p.analysis!.eyesClosed === false);
  if (!hasOpenEyedSibling) return { keep: photos, culled: [] };

  const culled: CulledPhoto[] = [];
  const culledIds = new Set<string>();
  let survivorCount = photos.length;
  for (const p of photos) {
    if (survivorCount <= MIN_SURVIVORS) break;
    if (p.assetId === protectedId || isForceIncluded(p)) continue;
    if (p.analysis?.eyesClosed === true) {
      culledIds.add(p.assetId);
      culled.push({ assetId: p.assetId, reason: 'eyes-closed' });
      survivorCount--;
    }
  }
  return { keep: photos.filter((p) => !culledIds.has(p.assetId)), culled };
}

/** A section whose surviving photo count exceeds this — once enough of it is actually
 *  scored to judge fairly — gets its lowest-`aestheticScore` surplus trimmed down to the
 *  cap (docs/PHOTO_BOOK_PLAN.md §6: "the lowest-scored surplus" when a section has "far
 *  more photos than the format prints well"). Roughly `SECTION_CAP_DIVISOR`'s target
 *  section size × 5 — big enough that ordinary sections never trigger this, small enough
 *  to actually bound a single massive cluster (e.g. 80 photos from one long day). */
const MAX_SCORED_SECTION_PHOTOS = 40;

/** A group needs at least this fraction of its photos scored before this cull trusts the
 *  scores enough to single anyone out — otherwise an unlucky, still-mostly-unanalyzed
 *  group could have its (essentially random) scored minority unfairly picked on. */
const MIN_SCORED_FRACTION_FOR_AESTHETIC_CULL = 0.8;

/** Neutral aesthetic score assigned to an unscored photo when comparing it against
 *  scored siblings — a photo with no opinion yet is treated as "average", never
 *  penalized purely for not being analyzed. */
const NEUTRAL_AESTHETIC_SCORE = 5;

/** Culls the lowest-`aestheticScore` surplus of an oversized, mostly-scored group — a
 *  no-op for any group at or under the cap, or where too little of it is scored yet (see
 *  `MIN_SCORED_FRACTION_FOR_AESTHETIC_CULL`), so an unscored/partially-scored book
 *  behaves exactly as PR2 did. Never reduces a group below the cap, so it can't combine
 *  with the other cullers to empty a section. `protectedId` (see `cullEyesClosed`'s doc
 *  comment) is excluded from the surplus candidate pool entirely, so it can never be
 *  picked as part of the "lowest-scored surplus" no matter how low its own score is —
 *  the surplus size itself is unchanged, it's just drawn only from the non-protected
 *  photos. */
function cullLowAesthetic(
  photos: AutoLayoutPhoto[],
  protectedId: string | null,
): { keep: AutoLayoutPhoto[]; culled: CulledPhoto[] } {
  if (photos.length <= MAX_SCORED_SECTION_PHOTOS) return { keep: photos, culled: [] };
  const scoredCount = photos.filter((p) => p.analysis?.aestheticScore != null).length;
  if (scoredCount < photos.length * MIN_SCORED_FRACTION_FOR_AESTHETIC_CULL) return { keep: photos, culled: [] };

  const surplus = photos.length - MAX_SCORED_SECTION_PHOTOS;
  const sorted = photos
    .filter((p) => p.assetId !== protectedId && !isForceIncluded(p))
    .sort(
      (a, b) =>
        (a.analysis?.aestheticScore ?? NEUTRAL_AESTHETIC_SCORE) -
          (b.analysis?.aestheticScore ?? NEUTRAL_AESTHETIC_SCORE) || a.position - b.position,
    );
  const culledIds = new Set(sorted.slice(0, surplus).map((p) => p.assetId));
  const culled: CulledPhoto[] = sorted
    .slice(0, surplus)
    .map((p) => ({ assetId: p.assetId, reason: 'low-quality' as const }));
  return { keep: photos.filter((p) => !culledIds.has(p.assetId)), culled };
}

/** The "non-blurry" pool for opener/cover picking: everyone, unless blur scores are
 *  available and distinguish a clearly sharper subset (same relative rule as
 *  `cullBlurry`, but non-destructive — this never removes a photo from the plan, it only
 *  affects which one gets the hero slot). */
function nonBlurryPool(photos: AutoLayoutPhoto[]): AutoLayoutPhoto[] {
  const scored = photos.filter((p) => p.blurScore != null);
  if (scored.length === 0) return photos;
  const maxBlur = Math.max(...scored.map((p) => p.blurScore!));
  if (maxBlur <= 0) return photos;
  const sharp = photos.filter((p) => p.blurScore == null || p.blurScore >= maxBlur * BLUR_RELATIVE_THRESHOLD);
  return sharp.length > 0 ? sharp : photos;
}

/**
 * The single best photo of a pool, for section openers and the cover hero
 * (docs/PHOTO_BOOK_PLAN.md §6: "prefer coverCandidate + high aestheticScore … falling
 * back to the PR2 resolution-based pick when no analysis"). When NOTHING in the pool has
 * an `analysis`, this is byte-for-byte the PR2 heuristic (highest resolution, assetId
 * tiebreak) — the exact case every PR2 test exercises. As soon as at least one photo in
 * the pool is scored, `coverCandidate` (then `aestheticScore`, unscored photos treated as
 * neutral — see `NEUTRAL_AESTHETIC_SCORE`) becomes the primary ranking, with resolution/
 * assetId only as the final tiebreak — so a book whose vision pass is still catching up
 * on a handful of photos already benefits from whatever scores it has.
 */
function pickBestPhoto(photos: AutoLayoutPhoto[]): AutoLayoutPhoto | null {
  if (photos.length === 0) return null;
  const pool = nonBlurryPool(photos);
  const anyAnalyzed = pool.some((p) => p.analysis != null);

  return pool.reduce((best, p) => {
    if (anyAnalyzed) {
      const pCover = p.analysis?.coverCandidate ? 1 : 0;
      const bestCover = best.analysis?.coverCandidate ? 1 : 0;
      if (pCover !== bestCover) return pCover > bestCover ? p : best;
      const pAesthetic = p.analysis?.aestheticScore ?? NEUTRAL_AESTHETIC_SCORE;
      const bestAesthetic = best.analysis?.aestheticScore ?? NEUTRAL_AESTHETIC_SCORE;
      if (pAesthetic !== bestAesthetic) return pAesthetic > bestAesthetic ? p : best;
    }
    const r = p.width * p.height;
    const br = best.width * best.height;
    if (r !== br) return r > br ? p : best;
    return p.assetId < best.assetId ? p : best;
  });
}

function singleTemplate(p: AutoLayoutPhoto): 'full-bleed' | 'full-framed' {
  return classify(p) === 'landscape' ? 'full-bleed' : 'full-framed';
}

function pairTemplate(a: AutoLayoutPhoto, b: AutoLayoutPhoto): 'two-vertical' | 'two-horizontal' {
  return classify(a) === 'portrait' && classify(b) === 'portrait' ? 'two-vertical' : 'two-horizontal';
}

function groupPage(group: AutoLayoutPhoto[]): PhotoPagePlan {
  const assetIds = group.map((g) => g.assetId);
  if (group.length === 2) return { template: pairTemplate(group[0], group[1]), assetIds };
  if (group.length === 3) {
    if (group.every((p) => classify(p) === 'portrait')) {
      return { template: 'three-column', assetIds };
    }
    // three-mixed's dominant (first) slot spans the full width, so it must be the
    // landscape — or failing that a square — photo (`TEMPLATE_SHAPE_RULES`,
    // `lib/photo-book-lint.ts`); promote one to the front rather than trusting order.
    const dominant =
      group.find((p) => classify(p) === 'landscape') ?? group.find((p) => classify(p) === 'square') ?? group[0];
    const rest = group.filter((p) => p !== dominant);
    return { template: 'three-mixed', assetIds: [dominant.assetId, ...rest.map((p) => p.assetId)] };
  }
  if (group.length === 4) {
    // Exactly one landscape among four reads best as the dominant full-width photo with
    // the other three justified below it (mirrors `templateForGroup` in
    // `lib/photo-book-repair.ts`); any other mix balances fine as a 2+2 grid.
    const landscapes = group.filter((p) => classify(p) === 'landscape');
    if (landscapes.length === 1) {
      const rest = group.filter((p) => p !== landscapes[0]);
      return { template: 'four-mixed', assetIds: [landscapes[0].assetId, ...rest.map((p) => p.assetId)] };
    }
    return { template: 'collage-4', assetIds };
  }
  return { template: 'collage-5', assetIds };
}

/**
 * Paces one section's surviving (post-cull) photos into pages: an opener (the section's
 * best non-blurry, highest-resolution photo) on its own full page, then the rest grouped
 * 2-4 at a time by aspect-ratio compatibility, 5 only as an exact-fit tail — never a lone
 * leftover photo squeezed onto a multi-slot template (any true leftover of 1 becomes its
 * own full page instead, which fills it rather than stranding it in white space).
 */
function paceSection(photos: AutoLayoutPhoto[]): PhotoPagePlan[] {
  if (photos.length === 0) return [];
  const opener = pickBestPhoto(photos)!;
  const pages: PhotoPagePlan[] = [{ template: singleTemplate(opener), assetIds: [opener.assetId] }];

  const queue = photos.filter((p) => p.assetId !== opener.assetId);
  while (queue.length > 0) {
    const remaining = queue.length;
    if (remaining === 1) {
      const p = queue.shift()!;
      pages.push({ template: singleTemplate(p), assetIds: [p.assetId] });
      break;
    }
    if (remaining === 2) {
      pages.push(groupPage(queue.splice(0, 2)));
      break;
    }
    if (remaining <= 5) {
      pages.push(groupPage(queue.splice(0, remaining)));
      break;
    }
    // remaining >= 6: peel off 3 or 4 so what's left after this page is never 1 or 2 —
    // remaining % 3 === 1 (4, 7, 10, …) takes 4 now to leave a multiple of 3; every other
    // case takes 3. The tail this converges to is always 3, 4, or 5, handled above.
    const take = remaining % 3 === 1 ? 4 : 3;
    pages.push(groupPage(queue.splice(0, take)));
  }
  return pages;
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Non-chronological groupings (`lib/photo-book-grouping.ts`): the user's "organise this
 * book by topic / by place" choice.
 *
 * Chronological sectioning above is *sequential* — sections are a partition of one
 * timeline, so only ADJACENT groups may merge and order is fixed. Topic and location are
 * not: any two clusters may be the closest pair, and the resulting sections have to be put
 * in some order afterwards. That's why these use their own affinity-based consolidation
 * rather than reusing `mergeTinySections`/`capSectionCount`, which are left exactly as they
 * were so chronological books lay out byte-for-byte as before.
 * ────────────────────────────────────────────────────────────────────────────── */

/** Photos within this radius of a cluster's centroid belong to the same place. Chosen to
 *  hold a whole town/resort/trip destination together (so a week in one place is one
 *  section, not one per excursion) while still separating genuinely different places —
 *  the same order of magnitude as `GPS_JUMP_KM`'s "a short flight/drive" boundary. */
const LOCATION_CLUSTER_KM = 25;

/** Groups photos by GPS proximity: greedy single-pass clustering against running centroids,
 *  oldest photo first so a cluster is seeded by the first visit to a place. Photos with no
 *  coordinates can't be placed at all — they come back as a trailing group, exactly like
 *  undated photos in chronological mode. */
function sectionizeByLocation(photos: AutoLayoutPhoto[]): { groups: AutoLayoutPhoto[][]; leftover: AutoLayoutPhoto[] } {
  const located = photos
    .filter((p) => p.gpsLat != null && p.gpsLng != null)
    .slice()
    .sort((a, b) => (a.takenAt?.getTime() ?? 0) - (b.takenAt?.getTime() ?? 0) || a.position - b.position);
  const leftover = photos.filter((p) => p.gpsLat == null || p.gpsLng == null).sort((a, b) => a.position - b.position);

  const clusters: { photos: AutoLayoutPhoto[]; lat: number; lng: number }[] = [];
  for (const photo of located) {
    let best: (typeof clusters)[number] | null = null;
    let bestKm = Infinity;
    for (const cluster of clusters) {
      const km = haversineKm(cluster.lat, cluster.lng, photo.gpsLat!, photo.gpsLng!);
      if (km < bestKm) {
        bestKm = km;
        best = cluster;
      }
    }
    if (best && bestKm <= LOCATION_CLUSTER_KM) {
      // Running mean, so a cluster's centre follows the photos actually in it rather than
      // being pinned to whichever one happened to arrive first.
      best.lat = (best.lat * best.photos.length + photo.gpsLat!) / (best.photos.length + 1);
      best.lng = (best.lng * best.photos.length + photo.gpsLng!) / (best.photos.length + 1);
      best.photos.push(photo);
    } else {
      clusters.push({ photos: [photo], lat: photo.gpsLat!, lng: photo.gpsLng! });
    }
  }
  return { groups: clusters.map((c) => c.photos), leftover };
}

/** The scene tags a photo contributes, lowercased. Empty for a photo the vision pass hasn't
 *  scored — those can't be grouped by topic and land in the trailing group. */
function tagsOf(photo: AutoLayoutPhoto): string[] {
  return (photo.analysis?.sceneTags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean);
}

/** Groups photos by their most distinctive shared scene tag: each photo joins the cluster of
 *  its rarest tag, so a "birthday" photo that also carries the ubiquitous "group photo" tag
 *  lands with the other birthdays rather than in a catch-all. Photos with no tags come back
 *  as a trailing group. */
function sectionizeByTopic(photos: AutoLayoutPhoto[]): { groups: AutoLayoutPhoto[][]; leftover: AutoLayoutPhoto[] } {
  const frequency = new Map<string, number>();
  for (const photo of photos) {
    for (const tag of new Set(tagsOf(photo))) frequency.set(tag, (frequency.get(tag) ?? 0) + 1);
  }

  const byTag = new Map<string, AutoLayoutPhoto[]>();
  const leftover: AutoLayoutPhoto[] = [];
  for (const photo of photos) {
    const tags = [...new Set(tagsOf(photo))];
    if (tags.length === 0) {
      leftover.push(photo);
      continue;
    }
    // Rarest tag wins; ties broken alphabetically so the grouping stays deterministic.
    const key = tags.sort((a, b) => (frequency.get(a) ?? 0) - (frequency.get(b) ?? 0) || a.localeCompare(b))[0];
    const bucket = byTag.get(key) ?? [];
    bucket.push(photo);
    byTag.set(key, bucket);
  }

  const groups = [...byTag.values()].map((g) =>
    g.slice().sort((a, b) => (a.takenAt?.getTime() ?? 0) - (b.takenAt?.getTime() ?? 0) || a.position - b.position),
  );
  return { groups, leftover: leftover.sort((a, b) => a.position - b.position) };
}

/** How strongly two groups want to be merged — higher is closer. */
type Affinity = (a: AutoLayoutPhoto[], b: AutoLayoutPhoto[]) => number;

/** Mean position of a group, for location affinity. */
function centroid(photos: AutoLayoutPhoto[]): { lat: number; lng: number } | null {
  const located = photos.filter((p) => p.gpsLat != null && p.gpsLng != null);
  if (located.length === 0) return null;
  return {
    lat: located.reduce((s, p) => s + p.gpsLat!, 0) / located.length,
    lng: located.reduce((s, p) => s + p.gpsLng!, 0) / located.length,
  };
}

const locationAffinity: Affinity = (a, b) => {
  const ca = centroid(a);
  const cb = centroid(b);
  if (!ca || !cb) return -Infinity;
  return -haversineKm(ca.lat, ca.lng, cb.lat, cb.lng);
};

/** Jaccard overlap of the two groups' tag vocabularies. */
const topicAffinity: Affinity = (a, b) => {
  const ta = new Set(a.flatMap(tagsOf));
  const tb = new Set(b.flatMap(tagsOf));
  if (ta.size === 0 || tb.size === 0) return -Infinity;
  let shared = 0;
  for (const tag of ta) if (tb.has(tag)) shared++;
  return shared / (ta.size + tb.size - shared);
};

/** Merges undersized groups into their closest sibling, then merges the closest remaining
 *  pair until the group count is under the same size-proportional cap chronological mode
 *  uses. Any pair may merge (see the section header). A group with no affinity to anything
 *  (`-Infinity` everywhere — e.g. the only one with GPS) is left alone rather than forced
 *  into an arbitrary neighbour. */
function consolidateByAffinity(groups: AutoLayoutPhoto[][], affinity: Affinity, totalPhotos: number): AutoLayoutPhoto[][] {
  const out = groups.map((g) => g.slice());

  function bestPartner(index: number): number | null {
    let best: number | null = null;
    let bestScore = -Infinity;
    for (let j = 0; j < out.length; j++) {
      if (j === index) continue;
      const score = affinity(out[index], out[j]);
      if (score > bestScore) {
        bestScore = score;
        best = j;
      }
    }
    return bestScore === -Infinity ? null : best;
  }

  let merged = true;
  while (merged && out.length > 1) {
    merged = false;
    for (let i = 0; i < out.length; i++) {
      if (out[i].length >= MIN_SECTION_SIZE) continue;
      const partner = bestPartner(i);
      if (partner == null) continue;
      out[partner] = [...out[partner], ...out[i]];
      out.splice(i, 1);
      merged = true;
      break; // structure changed — restart the scan
    }
  }

  const maxSections = Math.max(1, Math.ceil(totalPhotos / SECTION_CAP_DIVISOR));
  while (out.length > maxSections && out.length > 1) {
    let bestPair: [number, number] | null = null;
    let bestScore = -Infinity;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const score = affinity(out[i], out[j]);
        if (score > bestScore) {
          bestScore = score;
          bestPair = [i, j];
        }
      }
    }
    // Nothing has any affinity left (all groups mutually unrelated) — merging further would
    // be arbitrary, so accept being over the cap.
    if (!bestPair) break;
    const [i, j] = bestPair;
    out[i] = [...out[i], ...out[j]];
    out.splice(j, 1);
  }

  return out;
}

/** Earliest capture time in a group, for ordering sections. Groups with no dated photo sort
 *  last (Infinity), which is where an undated/unlocated tail belongs. */
function earliestTime(photos: AutoLayoutPhoto[]): number {
  const times = photos.filter((p) => p.takenAt != null).map((p) => p.takenAt!.getTime());
  return times.length > 0 ? Math.min(...times) : Number.POSITIVE_INFINITY;
}

/**
 * The candidate photo groupings for a book — sectioning, tiny-section merge, section-count
 * cap — for the user's chosen organisation (`lib/photo-book-grouping.ts`). Exactly what
 * `buildPhotoBookAutoLayout` uses for its own sections, exposed standalone so the AI design
 * pass (`lib/photo-book-ai-layout.ts`) can label each photo with a candidate cluster in its
 * prompt, giving the model a sensible starting point for its own section boundaries instead
 * of inventing groupings from raw timestamps itself. Excluding already-excluded photos is
 * the caller's job — this groups whatever `photos` it's given.
 *
 * `'chronological'` (the default, and what every book got before the setting existed) is
 * unchanged. The other two group by place/theme and are then ORDERED by their earliest
 * photo, so even a by-topic book still moves broadly forwards in time rather than landing
 * in whatever order the clustering happened to produce.
 */
export function computeCandidateSections(
  photos: AutoLayoutPhoto[],
  grouping: PhotoBookGrouping = DEFAULT_PHOTO_BOOK_GROUPING,
): AutoLayoutPhoto[][] {
  if (grouping === 'chronological') {
    const { dated, undated } = splitByCaptureTime(photos);
    let groups = mergeTinySections(sectionizeByBoundary(dated));
    if (undated.length > 0) groups = [...groups, undated];
    return capSectionCount(groups);
  }

  const { groups: raw, leftover } =
    grouping === 'location' ? sectionizeByLocation(photos) : sectionizeByTopic(photos);
  const affinity = grouping === 'location' ? locationAffinity : topicAffinity;
  // The leftover tail (no GPS / no tags) is consolidated separately — it has no affinity to
  // anything by definition, so it would otherwise block the merge loops.
  const consolidated = consolidateByAffinity(raw, affinity, photos.length).sort(
    (a, b) => earliestTime(a) - earliestTime(b),
  );
  if (leftover.length === 0) return consolidated;
  // A handful of unplaceable photos joins the last section rather than earning a section of
  // its own; a real pile of them gets one.
  if (leftover.length < MIN_SECTION_SIZE && consolidated.length > 0) {
    const last = consolidated[consolidated.length - 1];
    return [...consolidated.slice(0, -1), [...last, ...leftover]];
  }
  return [...consolidated, leftover];
}

/**
 * Sanitizes a pinned (`books.cover_asset_id`) or carried-over (a prior plan's
 * `cover.heroAssetId`) hero id down to one that's actually present-and-usable in the
 * current photo set, or `null` if it isn't. Callers into `buildPhotoBookAutoLayout` MUST
 * run both `coverAssetId` and `existingHeroAssetId` through this first:
 * `buildPhotoBookAutoLayout` itself trusts whatever hero id it's given (see its own doc
 * comment) — it protects that id from culling and echoes it straight to
 * `plan.cover.heroAssetId` unconditionally, it never checks the id actually names a photo
 * that's still in the book. A stale id (the photo was since excluded, or removed from the
 * book entirely) making it through unfiltered means `plan.cover.heroAssetId` ends up
 * pointing at a photo outside the surviving set, which `checkPhotoBookPlanConsistency`
 * rejects — and `buildAndPersistPhotoAutoPlan` (`lib/photo-book-content.ts`) then discards
 * the WHOLE plan for an empty one, not just the cover (docs/PHOTO_BOOK_PLAN.md PR3 FIX 1b:
 * excluding the current cover-hero photo used to blank the entire regenerated book).
 * Mirrors the guard `applyPhotoPlanCarryOver` (`lib/photo-book-ai-layout.ts`) already
 * applies to the AI design path. `usablePhotos` should be the same present-and-non-excluded
 * set `buildPhotoBookAutoLayout` will itself be called with.
 */
export function resolveUsableHeroId(
  id: string | null | undefined,
  usablePhotos: Pick<AutoLayoutPhoto, 'assetId'>[],
): string | null {
  if (!id) return null;
  return usablePhotos.some((p) => p.assetId === id) ? id : null;
}

/** Builds a full photo-book layout plan from a book's currently-available photos. */
export function buildPhotoBookAutoLayout(input: PhotoBookAutoLayoutInput): PhotoBookAutoLayoutResult {
  const locale = input.dateLocale ?? 'de-DE';
  const undatedTitle = input.undatedSectionTitle ?? 'Weitere Fotos';

  // A force-excluded photo is dropped before anything else runs — it must never be
  // sectioned, culled (it's not a "cull", the user already decided), placed, or picked as
  // cover. In practice the loader (`buildAndPersistPhotoAutoPlan`) only ever passes
  // `excluded = false` rows, so `userDecision === 'exclude'` alongside `excluded === false`
  // shouldn't occur — this filter is defense in depth so the pure function's own contract
  // ("a force-excluded photo is ALWAYS excluded") holds regardless of caller behavior.
  const usablePhotos = input.photos.filter((p) => p.userDecision !== 'exclude');

  const grouping = input.grouping ?? DEFAULT_PHOTO_BOOK_GROUPING;
  const groups = computeCandidateSections(usablePhotos, grouping);

  // Resolved up front (before any culling runs) so the score-aware cullers below can
  // protect it from their own candidacy — see `cullEyesClosed`'s doc comment for why. A
  // pinned cover always wins over a carried-over one, same precedence `heroAssetId`
  // itself uses further down.
  //
  // NOTE: this function intentionally does NOT validate that `coverAssetId` /
  // `existingHeroAssetId` reference a photo actually present in `input.photos` — it
  // trusts the caller (unlike the `userDecision` filter above, which guards this
  // function's OWN internal invariant). `buildAndPersistPhotoAutoPlan`
  // (`lib/photo-book-content.ts`) is responsible for only ever passing a hero id that's
  // present-and-non-excluded in the current photo set, via `resolveUsableHeroId` below —
  // see that function's doc comment for the bug this guards against
  // (docs/PHOTO_BOOK_PLAN.md PR3 FIX 1b).
  const protectedHeroId = input.coverAssetId ?? input.existingHeroAssetId ?? null;

  const culled: CulledPhoto[] = [];
  const survivorsForCover: AutoLayoutPhoto[] = [];
  // Post-cull photos per group, kept alongside the ORIGINAL group (pre-cull, still used
  // for `sectionTitle`'s date range) — two passes are needed because the cover hero can
  // only be chosen once every group's culling has run (it's picked from the full,
  // book-wide survivor pool), but pacing each section needs to know the hero first (to
  // exclude it — see below), so the pass that builds pages can't happen until after hero
  // selection.
  const groupKeeps: { group: AutoLayoutPhoto[]; keep: AutoLayoutPhoto[] }[] = [];

  for (const group of groups) {
    if (group.length === 0) continue;
    const dupResult = cullDuplicates(group);
    culled.push(...dupResult.culled);
    const blurResult = cullBlurry(dupResult.keep);
    culled.push(...blurResult.culled);
    // The two score-aware cullers below are no-ops whenever `analysis` is absent (see
    // their own doc comments) — a book with no vision data yet culls identically to PR2.
    // Both are handed `protectedHeroId` so the resolved cover hero (pinned or carried
    // over) can never be culled out from under `plan.cover.heroAssetId`.
    const eyesResult = cullEyesClosed(blurResult.keep, protectedHeroId);
    culled.push(...eyesResult.culled);
    const aestheticResult = cullLowAesthetic(eyesResult.keep, protectedHeroId);
    culled.push(...aestheticResult.culled);
    const keep = aestheticResult.keep;
    if (keep.length === 0) continue;

    survivorsForCover.push(...keep);
    groupKeeps.push({ group, keep });
  }

  const bestOverall = pickBestPhoto(survivorsForCover);
  const heroAssetId = protectedHeroId ?? bestOverall?.assetId;

  // The cover hero (however it was chosen — pinned, carried over, or auto-picked) is the
  // book's front-cover image and must NOT also turn up as an interior page: `paceSection`
  // independently picks each section's own opener by the same "best photo" criterion, so
  // without this filter the hero's section would place it a second time as its own
  // opener, producing a duplicate `assetId` that fails `checkPhotoBookPlanConsistency`
  // (mirrors `buildChapterBlocks`'s `pool = pool.filter(...)` in `lib/book-autolayout.ts`,
  // which solves the same problem for story books).
  const sections: PhotoOnlySectionPlan[] = [];
  for (const { group, keep } of groupKeeps) {
    const interior = heroAssetId ? keep.filter((p) => p.assetId !== heroAssetId) : keep;
    // Excluding the hero can leave a section with nothing left (e.g. a single-photo
    // section whose only photo IS the hero) — drop it rather than emit an empty section,
    // which `checkPhotoBookPlanConsistency` also rejects.
    if (interior.length === 0) continue;
    sections.push({
      title: sectionTitle(group, locale, undatedTitle, grouping),
      pages: paceSection(interior),
    });
  }

  const plan: PhotoOnlyBookPlan = {
    kind: 'photo',
    style: input.existingStyle ?? 'classic',
    cover: {
      ...(heroAssetId ? { heroAssetId } : {}),
      title: input.existingCoverTitle ?? input.title,
      ...((input.existingCoverSubtitle ?? input.subtitle) ? { subtitle: (input.existingCoverSubtitle ?? input.subtitle) as string } : {}),
    },
    sections,
  };

  return { plan, culled };
}
