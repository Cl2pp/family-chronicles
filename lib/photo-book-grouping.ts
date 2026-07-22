/**
 * How a photo book's chapters are formed: the user's own answer to "what makes two photos
 * belong on the same spread?", chosen in the builder's config panel BEFORE the book is
 * generated (`books.photo_grouping`).
 *
 * It is a real editorial decision, not a preference toggle: the same 200 photos become a
 * travel diary, a book of occasions, or a book of places depending on it. So it feeds both
 * producers — the AI design pass (`lib/photo-book-ai-layout.ts`, which gets both the
 * instruction and candidate clusters computed this way) and the deterministic auto-layouter
 * (`lib/photo-book-autolayout.ts`'s `computeCandidateSections`) — rather than being a hint
 * in a prompt somewhere.
 *
 * Pure and dependency-free: the client config panel, the worker, and the layouter all
 * import it.
 */

export const PHOTO_BOOK_GROUPINGS = [
  /** By time: one section per outing/day/trip, in the order they happened. The default —
   *  a family photo book is usually a timeline. */
  'chronological',
  /** By what the photos SHOW — birthdays together, beach days together — regardless of
   *  when they were taken. */
  'topic',
  /** By WHERE they were taken, from EXIF GPS. Photos with no location fall into a
   *  trailing section, the same way undated photos do in chronological mode. */
  'location',
] as const;

export type PhotoBookGrouping = (typeof PHOTO_BOOK_GROUPINGS)[number];

export const DEFAULT_PHOTO_BOOK_GROUPING: PhotoBookGrouping = 'chronological';

/** Narrows a raw `books.photo_grouping` value (an untyped text column, null on every book
 *  created before this existed) to a known grouping, defaulting to chronological. */
export function parsePhotoGrouping(value: unknown): PhotoBookGrouping {
  return typeof value === 'string' && (PHOTO_BOOK_GROUPINGS as readonly string[]).includes(value)
    ? (value as PhotoBookGrouping)
    : DEFAULT_PHOTO_BOOK_GROUPING;
}

/** Below this share of photos carrying what a grouping needs, the clustering collapses into
 *  one meaningless chapter and the builder says so before committing to it. */
export const MIN_GROUPING_COVERAGE = 0.5;

/** The per-photo facts a grouping needs — `book_photos.gps_lat` for by-place, a vision
 *  score for by-topic. Matches the builder's `PhotoBookPhotoView` so it can be passed
 *  straight in. */
export interface GroupingCoveragePhoto {
  excluded: boolean;
  hasLocation: boolean;
  hasAnalysis: boolean;
}

export interface GroupingCoverage {
  /** Photos that carry what this grouping clusters on. */
  supported: number;
  /** Photos available to the layout at all (i.e. not excluded). */
  total: number;
  /** False when too few photos carry it for the grouping to produce real chapters. */
  sufficient: boolean;
}

/**
 * How well a photo set can actually support a grouping.
 *
 * "By place" needs EXIF GPS and "by topic" needs a vision score; a set that mostly lacks
 * either collapses into a single trailing chapter of unplaceable photos. That is not
 * hypothetical — the first real book we looked at had GPS on exactly none of its 36 photos
 * (messaging apps strip it, scans and screenshots never had it). Chronological needs
 * nothing, so it is always sufficient.
 *
 * Shared by the config panel (which shows the caveat for the chosen grouping) and the
 * builder (which asks before switching to one the photos can't carry — a switch on an
 * already-generated book spends a whole design pass).
 */
export function groupingCoverage(
  photos: GroupingCoveragePhoto[],
  grouping: PhotoBookGrouping,
): GroupingCoverage {
  const usable = photos.filter((p) => !p.excluded);
  const total = usable.length;
  if (grouping === 'chronological' || total === 0) {
    return { supported: total, total, sufficient: true };
  }
  const supported = usable.filter((p) => (grouping === 'location' ? p.hasLocation : p.hasAnalysis)).length;
  return { supported, total, sufficient: supported >= total * MIN_GROUPING_COVERAGE };
}

/**
 * The instruction handed to the design pass. Deliberately concrete about the two separate
 * decisions a grouping affects — how sections are FORMED, and how photos are ORDERED within
 * one — because those pull apart for the non-chronological modes: a "Birthdays" section
 * still reads best with its photos in the order they happened.
 */
export function groupingInstruction(grouping: PhotoBookGrouping): string {
  switch (grouping) {
    case 'topic':
      return `ORGANISE THIS BOOK BY TOPIC. The reader asked for a book of occasions and themes, not a timeline. Group photos by what they actually SHOW — a birthday, a beach day, cooking together, the dog — even when that puts photos from different months, or different years, in the same section. Use the photos' scene tags, descriptions and the images themselves to decide what belongs together, not their timestamps. Give every section a title naming its theme. Within a section, still order the photos oldest-first so a theme that recurs over the years reads as a progression. Order the sections themselves so the book opens on the strongest, most representative theme; the candidate clusters below are grouped by topic to start you off.`;
    case 'location':
      return `ORGANISE THIS BOOK BY PLACE. The reader asked for a book of places, not a timeline. Group photos by WHERE they were taken — every photo from one trip destination, one town, one house together in a single section, even when they were taken months apart. The photo list gives GPS coordinates where the camera recorded them; the candidate clusters below are already grouped by location. Photos with no coordinates are grouped separately at the end — place them by what they look like if you can recognise where they belong, otherwise keep them as a closing section. Name each section after the place if you can tell what it is from the photos (a beach, a city, "Zuhause"); never leave a section named after coordinates. Within a section, order the photos oldest-first.`;
    case 'chronological':
    default:
      return `ORGANISE THIS BOOK CHRONOLOGICALLY. This is a family memoir on a timeline: sections run oldest to newest, and so do the photos inside each one. A section is one occasion — a day out, a weekend away, a party — split where there is a real gap in time or a jump in place. The candidate clusters below are already grouped this way.`;
  }
}
