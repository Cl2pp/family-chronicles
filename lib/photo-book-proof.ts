import sharp from 'sharp';
import { withChromium } from '@/lib/chromium';
import { getObjectBuffer } from '@/lib/s3';
import { renderPhotoBookHtml, type PhotoLayoutImage } from '@/lib/photo-book-layout';
import { embeddedFontFaceCss } from '@/lib/photo-book-fonts';
import { referencedPhotoAssetIds, type LoadedPhotoBook } from '@/lib/photo-book-content';
import type { PhotoBookPlan } from '@/lib/photo-book-plan';
import type { PhotoBookLintFinding } from '@/lib/photo-book-lint';

/**
 * Renders a photo-book layout plan to page IMAGES, so the AI design pass can look at what
 * it actually produced (`lib/photo-book-ai-layout.ts`'s review round) instead of only
 * re-reading its own JSON.
 *
 * This is the difference between the model reasoning about `{"template":"three-column"}`
 * and the model seeing three landscape photos squashed into a 40mm strip on a 280mm page.
 * A layout defect is a visual fact; the only reliable way to review it is to look.
 *
 * Worker-only (it launches Chromium and reads originals from S3) — imported exclusively by
 * `lib/photo-book-ai-layout.ts`, which the worker owns. Never import this from the web
 * process.
 *
 * Deliberately separate from `lib/book-render.ts`: that module's job is producing the
 * order-time PDFs and it owns the book's `status`/`preview_s3_key`/`print_s3_key` columns.
 * This one is a read-only side-channel — it renders, screenshots, and stores nothing.
 */

/** How many pages ride along as images. The whole book would be more thorough but the
 *  review prompt has to stay affordable; 14 covers a typical 20-40 page family book's
 *  problem pages plus a representative sample (see `selectProofPages`). */
const MAX_PROOF_PAGES = 14;

/** Longest edge per page screenshot. A page at this size still clearly shows "this row is
 *  a squashed strip" / "this photo is cropped through someone's head", which is all the
 *  review round needs to judge. */
const PROOF_MAX_EDGE = 900;
const PROOF_JPEG_QUALITY = 72;

/** Preview-grade embedding: the thumbnail is plenty for a layout proof and keeps a
 *  100-photo book from pulling camera originals through the worker. Mirrors the `preview`
 *  variant's source choice in `lib/book-render.ts`. */
const EMBED_MAX_EDGE = 640;

export interface ProofPageImage {
  /** 0-based index into the rendered page stack — page 0 is the front cover. */
  index: number;
  /** Human-readable position for the prompt ("front cover", "section 1 ('Am Strand'), page 2"). */
  label: string;
  dataUri: string;
}

/**
 * Which pages are worth showing the model, given a page budget: every page the linter
 * flagged first (those are the known-suspect ones), then an even spread across the rest so
 * the model still sees the book's overall rhythm rather than only its problems. Always
 * includes the front cover. Pure — exported for testing.
 */
export function selectProofPages(
  labels: string[],
  flaggedIndices: number[],
  max: number = MAX_PROOF_PAGES,
): number[] {
  const picked = new Set<number>();
  if (labels.length > 0) picked.add(0); // front cover
  for (const i of flaggedIndices) {
    if (picked.size >= max) break;
    if (i >= 0 && i < labels.length) picked.add(i);
  }
  const remaining = max - picked.size;
  if (remaining > 0) {
    const candidates = labels.map((_, i) => i).filter((i) => !picked.has(i));
    const step = Math.max(1, Math.ceil(candidates.length / remaining));
    for (let i = 0; i < candidates.length && picked.size < max; i += step) picked.add(candidates[i]);
  }
  return [...picked].sort((a, b) => a - b);
}

/**
 * The label for every page the renderer will emit, in render order — mirrors
 * `renderPhotoBookHtml`'s own page order exactly (front cover, back cover, then each
 * section's divider followed by its pages). Also returns, for each `(sectionIndex,
 * pageIndex)` pair the linter reports, which flat page index it lands on, so a finding can
 * be turned into "show the model THIS page". Pure — exported for testing.
 */
export function planPageLabels(plan: PhotoBookPlan): {
  labels: string[];
  indexOf: (sectionIndex: number, pageIndex: number) => number | null;
} {
  const labels: string[] = ['front cover', 'back cover'];
  const map = new Map<string, number>();
  plan.sections.forEach((section, si) => {
    labels.push(`section ${si} ("${section.title}") — divider`);
    section.pages.forEach((_, pi) => {
      map.set(`${si}:${pi}`, labels.length);
      labels.push(`section ${si} ("${section.title}"), page ${pi}`);
    });
  });
  return { labels, indexOf: (si, pi) => map.get(`${si}:${pi}`) ?? null };
}

/** The flat page indices the linter's findings point at, deduped and in order. */
export function flaggedPageIndices(plan: PhotoBookPlan, findings: PhotoBookLintFinding[]): number[] {
  const { indexOf } = planPageLabels(plan);
  const out: number[] = [];
  for (const f of findings) {
    if (f.sectionIndex == null || f.pageIndex == null) continue;
    const idx = indexOf(f.sectionIndex, f.pageIndex);
    if (idx != null && !out.includes(idx)) out.push(idx);
  }
  return out;
}

async function embedImages(loaded: LoadedPhotoBook, plan: PhotoBookPlan): Promise<Map<string, PhotoLayoutImage>> {
  const byId = new Map(loaded.photos.map((p) => [p.assetId, p]));
  const resolved = new Map<string, PhotoLayoutImage>();
  for (const id of referencedPhotoAssetIds(plan)) {
    const photo = byId.get(id);
    if (!photo || photo.excluded || !photo.width || !photo.height) continue;
    try {
      const buffer = await getObjectBuffer(photo.thumbS3Key ?? photo.s3Key);
      const out = await sharp(buffer, { failOn: 'none' })
        .rotate()
        .resize({ width: EMBED_MAX_EDGE, height: EMBED_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 60, mozjpeg: true })
        .toBuffer();
      resolved.set(id, {
        assetId: id,
        src: `data:image/jpeg;base64,${out.toString('base64')}`,
        width: photo.width,
        height: photo.height,
      });
    } catch (e) {
      // A photo that won't decode renders as an empty slot — the proof is still useful.
      console.warn(`[photo-book-proof] could not embed ${photo.s3Key}:`, e);
    }
  }
  return resolved;
}

/**
 * Renders `plan` and screenshots the selected pages. Returns `[]` (never throws) if
 * anything goes wrong — the review round is an enhancement, so a Chromium failure must
 * degrade to "review the plan without pictures", not fail the design pass.
 */
export async function renderProofPages(
  loaded: LoadedPhotoBook,
  plan: PhotoBookPlan,
  chronicleName: string,
  trim: { w: number; h: number },
  wantedIndices: number[],
): Promise<ProofPageImage[]> {
  if (wantedIndices.length === 0) return [];
  const { labels } = planPageLabels(plan);

  try {
    const images = await embedImages(loaded, plan);
    const html = renderPhotoBookHtml({
      // `preview` (not `screen`): no Paged.js, no client-side pagination to wait on — every
      // `.page` section is already its own explicitly-sized box, which is exactly what an
      // element screenshot needs.
      variant: 'preview',
      chronicleName,
      trim,
      plan,
      images,
      fontFaceCss: embeddedFontFaceCss(plan.style),
      createdLabel: new Date().toLocaleDateString('de-DE', { year: 'numeric', month: 'long' }),
      // The `preview` variant always stamps a watermark; an empty string renders nothing,
      // keeping the proof clean for the model to judge.
      watermarkText: '',
    });

    // Shared, serialized browser (`lib/chromium.ts`) — a proof render must never run a
    // second Chromium alongside a print render on the same box.
    return await withChromium('photo-book proof', async (browser) => {
      const page = await browser.newPage();
      await page.setViewport({ width: 1200, height: 1600, deviceScaleFactor: 1 });
      await page.setContent(html, { waitUntil: 'load', timeout: 120_000 });

      const handles = await page.$$('section.page');
      const out: ProofPageImage[] = [];
      for (const index of wantedIndices) {
        const handle = handles[index];
        if (!handle) continue;
        try {
          const shot = (await handle.screenshot({ type: 'png' })) as Buffer;
          const jpeg = await sharp(shot)
            .resize({ width: PROOF_MAX_EDGE, height: PROOF_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: PROOF_JPEG_QUALITY, mozjpeg: true })
            .toBuffer();
          out.push({
            index,
            label: labels[index] ?? `page ${index}`,
            dataUri: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
          });
        } catch (e) {
          console.warn(`[photo-book-proof] failed to screenshot page ${index}:`, e);
        }
      }
      return out;
    });
  } catch (e) {
    console.error('[photo-book-proof] proof render failed, continuing without page images:', e);
    return [];
  }
}
