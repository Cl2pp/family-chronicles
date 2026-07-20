import { hammingDistance } from '@/lib/photo-hash';
import type { PhotoBookPlan, PhotoBookStyle, PhotoPagePlan, PhotoSectionPlan } from '@/lib/photo-book-plan';

/**
 * The photo-book deterministic auto-layouter (docs/PHOTO_BOOK_PLAN.md §6, producer #1) —
 * the photo-book counterpart of `lib/book-autolayout.ts`. Pure function: no I/O, no
 * randomness, same input always produces the same plan. Runs the instant a book's photos
 * have their *metadata* analyzed (`photo-meta`, PR1) — vision scores (`PhotoAnalysis`,
 * aesthetics/eyes-closed/people) do NOT exist yet in PR2 (that's PR3's `photo-vision`
 * job), so every heuristic here works off `takenAt`, `gpsLat/Lng`, `phash`, `blurScore`,
 * and pixel dimensions only.
 *
 * Culling (near-duplicates, clearly-blurry photos) is computed here but NOT applied to
 * the database by this function — it only *reports* what it chose to omit and why. A
 * thin persistence wrapper (`lib/photo-book-content.ts`'s `buildAndPersistPhotoAutoPlan`)
 * writes those into `book_photos.excluded`/`excluded_reason` so the builder's tray can
 * show them and the user can override. This keeps the layouter pure (like
 * `buildLayoutPlan`) while still giving the "excluded ≠ deleted, one tap to re-include"
 * UX the plan calls for — and once persisted, an omitted photo is `excluded = true` in
 * the DB, so the NEXT call to this function (fed only `book_photos.excluded = false`
 * rows by the loader) never sees it again and can't re-cull it in an endless loop; a
 * user explicitly re-including it makes it eligible for culling again on the next
 * rebuild, which is the correct behavior (maybe the "duplicate" it used to lose to was
 * itself excluded by the user in the meantime).
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
}

export interface PhotoBookAutoLayoutInput {
  /** The book's title — the cover's default title when nothing has overridden it. */
  title: string;
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
  /** Every photo currently AVAILABLE to the layout — i.e. `book_photos.excluded = false`
   *  (a user's own exclusions are never second-guessed here; see the module header). */
  photos: AutoLayoutPhoto[];
}

export interface CulledPhoto {
  assetId: string;
  reason: 'duplicate' | 'blurry';
}

export interface PhotoBookAutoLayoutResult {
  plan: PhotoBookPlan;
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

/** Aspect-ratio buckets driving template choice (docs/PHOTO_BOOK_PLAN.md §6 pacing). */
type Orientation = 'portrait' | 'landscape' | 'square';

function classify(p: AutoLayoutPhoto): Orientation {
  const ratio = p.width / p.height;
  if (ratio < 0.9) return 'portrait';
  if (ratio > 1.1) return 'landscape';
  return 'square';
}

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
 *  capping. A group with no dated boundary photo (the undated tail) reads as gap 0
 *  (epoch to epoch), which sorts it last among merge candidates in practice since real
 *  gaps between real dated sections are almost always far larger than 0 — i.e. it's
 *  merged only when nothing else is left to merge. */
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

function sectionTitle(photos: AutoLayoutPhoto[], locale: string, undatedTitle: string): string {
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
    if (p.blurScore < maxBlur * BLUR_RELATIVE_THRESHOLD) {
      culledIds.add(p.assetId);
      culled.push({ assetId: p.assetId, reason: 'blurry' });
      survivorCount--;
    }
  }
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

/** Highest-resolution photo among the non-blurry pool; ties broken by assetId for
 *  determinism (mirrors `pickHighestResolution` in `lib/book-autolayout.ts`). */
function pickBestPhoto(photos: AutoLayoutPhoto[]): AutoLayoutPhoto | null {
  if (photos.length === 0) return null;
  const pool = nonBlurryPool(photos);
  return pool.reduce((best, p) => {
    const r = p.width * p.height;
    const br = best.width * best.height;
    if (r > br) return p;
    if (r === br && p.assetId < best.assetId) return p;
    return best;
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
    const template = group.every((p) => classify(p) === 'portrait') ? 'three-column' : 'three-mixed';
    return { template, assetIds };
  }
  if (group.length === 4) return { template: 'collage-4', assetIds };
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

/** Builds a full photo-book layout plan from a book's currently-available photos. */
export function buildPhotoBookAutoLayout(input: PhotoBookAutoLayoutInput): PhotoBookAutoLayoutResult {
  const locale = input.dateLocale ?? 'de-DE';
  const undatedTitle = input.undatedSectionTitle ?? 'Weitere Fotos';

  const { dated, undated } = splitByCaptureTime(input.photos);
  let groups = mergeTinySections(sectionizeByBoundary(dated));
  if (undated.length > 0) groups = [...groups, undated];
  groups = capSectionCount(groups);

  const culled: CulledPhoto[] = [];
  const survivorsForCover: AutoLayoutPhoto[] = [];
  const sections: PhotoSectionPlan[] = [];

  for (const group of groups) {
    if (group.length === 0) continue;
    const dupResult = cullDuplicates(group);
    culled.push(...dupResult.culled);
    const blurResult = cullBlurry(dupResult.keep);
    culled.push(...blurResult.culled);
    const keep = blurResult.keep;
    if (keep.length === 0) continue;

    survivorsForCover.push(...keep);
    sections.push({
      title: sectionTitle(group, locale, undatedTitle),
      pages: paceSection(keep),
    });
  }

  const bestOverall = pickBestPhoto(survivorsForCover);
  const heroAssetId = input.coverAssetId ?? input.existingHeroAssetId ?? bestOverall?.assetId;

  const plan: PhotoBookPlan = {
    kind: 'photo',
    style: input.existingStyle ?? 'classic',
    cover: {
      ...(heroAssetId ? { heroAssetId } : {}),
      title: input.existingCoverTitle ?? input.title,
      ...(input.existingCoverSubtitle ? { subtitle: input.existingCoverSubtitle } : {}),
    },
    sections,
  };

  return { plan, culled };
}
