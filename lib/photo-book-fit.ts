import {
  coverCropRetention,
  MIN_SAFE_COVER_RETENTION,
  PHOTO_BOOK_CONTENT_MARGIN_MM,
  rowStackCellSizesMm,
  TEMPLATE_ROW_ARRANGEMENT,
  type ContentBox,
} from '@/lib/photo-book-layout';
import { templateRendersCaptions, type PhotoPageTemplate } from '@/lib/photo-book-plan';

/** Pure, shared aspect-aware fitting decisions. The auto-layouter, repair pass, and
 * deterministic linter all use this module so they cannot disagree about which legal
 * template makes the best use of a page. */

export interface FittablePhoto {
  assetId: string;
  width: number;
  height: number;
  /** Whether this photo carries a rendered caption on the page being evaluated. */
  captioned?: boolean;
}

export const DEFAULT_PHOTO_BOOK_TRIM = { w: 210, h: 280 } as const;

export function photoBookContentBox(
  trim: { w: number; h: number } = DEFAULT_PHOTO_BOOK_TRIM,
): ContentBox {
  return {
    w: trim.w - PHOTO_BOOK_CONTENT_MARGIN_MM.inner - PHOTO_BOOK_CONTENT_MARGIN_MM.outer,
    h: trim.h - PHOTO_BOOK_CONTENT_MARGIN_MM.top - PHOTO_BOOK_CONTENT_MARGIN_MM.bottom - 1,
  };
}

/** Fraction of the usable page area occupied by actual photo pixels. Gaps, captions, and
 * deliberate white space do not count. This is a fitting metric, not an aesthetic score. */
export function photoPageAreaRatio(
  template: PhotoPageTemplate,
  photos: FittablePhoto[],
  box: ContentBox,
): number {
  const rows = TEMPLATE_ROW_ARRANGEMENT[template];
  if (!rows || photos.length === 0) return 0;
  const aspectRows: number[][] = [];
  let offset = 0;
  for (const size of rows) {
    const row = photos.slice(offset, offset + size);
    if (row.length !== size) return 0;
    aspectRows.push(row.map((p) => p.width / p.height));
    offset += size;
  }
  offset = 0;
  const rendersCaptions = templateRendersCaptions(template);
  const captionedRows = rows.map((size) => {
    const captioned = rendersCaptions && photos.slice(offset, offset + size).some((photo) => photo.captioned);
    offset += size;
    return captioned;
  });
  const cells = rowStackCellSizesMm(aspectRows, box, captionedRows);
  const photoArea = cells.flat().reduce((sum, cell) => sum + cell.w * cell.h, 0);
  return photoArea / (box.w * box.h);
}

const TEMPLATES_BY_COUNT: Record<number, PhotoPageTemplate[]> = {
  2: ['two-vertical', 'two-horizontal'],
  3: ['three-mixed', 'three-column'],
  4: ['four-mixed', 'collage-4'],
  5: ['collage-5'],
  6: ['collage-6'],
};

/** At most six photos are legal on a page, so exhaustive permutations are small (6! =
 *  720) and buy a meaningful improvement: which photos share each justified row changes
 *  its height and therefore the amount of the page the whole composition can use. */
function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const out: T[][] = [];
  items.forEach((item, index) => {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of permutations(rest)) out.push([item, ...tail]);
  });
  return out;
}

export interface BestPhotoPage<T extends FittablePhoto> {
  template: PhotoPageTemplate;
  ordered: T[];
  /** Actual photo area / usable page area. */
  areaRatio: number;
  /** Selection score: area plus a small conventional-layout preference for close calls. */
  fitScore: number;
}

/** Selects the legal template and within-page order that uses the most photo area without
 * cropping. Single photos use full-page cover only when the source and page shapes retain
 * at least `MIN_SAFE_COVER_RETENTION`; otherwise they get an intrinsic-aspect frame. */
export function bestPhotoPageForGroup<T extends FittablePhoto>(
  input: T[],
  trim: { w: number; h: number } = DEFAULT_PHOTO_BOOK_TRIM,
): BestPhotoPage<T> {
  if (input.length < 1 || input.length > 6) {
    throw new Error(`photo page groups must contain 1-6 photos, got ${input.length}`);
  }
  if (input.length === 1) {
    const photo = input[0];
    const retention = coverCropRetention(photo.width / photo.height, trim.w / trim.h);
    return {
      template: retention >= MIN_SAFE_COVER_RETENTION ? 'full-bleed' : 'full-framed',
      ordered: input.slice(),
      areaRatio: retention >= MIN_SAFE_COVER_RETENTION ? 1 : retention,
      fitScore: retention >= MIN_SAFE_COVER_RETENTION ? 1 : retention,
    };
  }

  const box = photoBookContentBox(trim);
  let best: BestPhotoPage<T> | null = null;
  const orderings = permutations(input);
  for (const template of TEMPLATES_BY_COUNT[input.length] ?? []) {
    for (const ordered of orderings) {
      const areaRatio = photoPageAreaRatio(template, ordered, box);
      // When two portraits are close by raw area, the familiar side-by-side spread reads
      // better than two narrow centered rows. Clear area wins still override this nudge.
      const allPortrait = input.every((p) => p.width / p.height < 0.9);
      const preference = input.length === 2 && allPortrait && template === 'two-vertical' ? 0.08 : 0;
      const fitScore = areaRatio + preference;
      if (!best || fitScore > best.fitScore + 1e-9) best = { template, ordered, areaRatio, fitScore };
    }
  }
  if (!best) throw new Error(`no photo-page template for ${input.length} photos`);
  return best;
}

/** Multi-photo arrangements below this are visibly contact-strip-like rather than
 * intentionally spacious. Used by the linter and by the auto-layouter's five-photo split. */
export const MIN_MULTI_PHOTO_AREA_RATIO = 0.42;

/** A materially better same-count arrangement should replace the current one. */
export const MIN_AREA_RATIO_IMPROVEMENT = 0.1;
