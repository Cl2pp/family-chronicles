import puppeteer, { type Browser, type Page } from 'puppeteer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/** `lib/book-print-file.ts` imports `lib/gelato.ts` for its page limits, and that file's
 *  import of the env module would otherwise validate the whole process environment
 *  (DATABASE_URL, S3, …) just to render a cover — same mock `lib/book-print-file.test.ts`
 *  uses, for the same reason. */
vi.mock('@/lib/env', () => ({ env: {} }));

import { GET as getPagedJsPolyfill } from '@/app/api/pagedjs-polyfill/route';
import { renderCoverSpreadHtml } from '@/lib/book-print-file';
import { embeddedFontFaceCss } from '@/lib/photo-book-fonts';
import { renderPhotoBookHtml, type PhotoLayoutImage } from '@/lib/photo-book-layout';
import type { GelatoCoverDimensions } from '@/lib/gelato';
import type { PhotoBookPlan } from '@/lib/photo-book-plan';

/**
 * The Birthday front cover has two pieces that used to be positioned independently of each
 * other — a collage box and a title block pinned to the sheet's bottom — so a title long
 * enough to wrap grew UPWARDS into the photos. With the backing panel behind the title
 * gone, that printed as words straight over the photographs. Both renderers now lay the
 * cover out as a COLUMN instead (collage band, then title, in normal flow), which is the
 * structural reason the two can no longer meet.
 *
 * "Can no longer meet" is a claim about real box geometry, not about CSS text, so this
 * file measures it in a real browser: for a 1-, 2- and 4-line title, at both trim sizes,
 * in both renderers, it asserts the collage's bottom edge never passes the title block's
 * top edge — and that the title itself still lands on the sheet.
 *
 * How each variant is measured:
 *  - `screen` runs the app's OWN self-hosted Paged.js response and measures the paginated
 *    DOM, exactly like `lib/photo-book-text-flow.integration.test.ts`.
 *  - `preview`/`print` (and the Gelato spread) are measured under `emulateMediaType`
 *    ('print'), which is the cascade Chromium's `page.pdf()` lays out with. Everything on
 *    this cover is an absolute-millimetre box on a single non-paginating page, so the DOM
 *    boxes here ARE the printed boxes.
 */

const PX_PER_MM = 96 / 25.4;
const toMm = (px: number) => px / PX_PER_MM;
/** Sub-pixel rounding, not a layout defect — the same 1px slack the flow test allows. */
const SLACK_MM = toMm(1);

/** A real (if tiny) PNG, so the tiles paint something with actual intrinsic dimensions. */
const TILE_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const PHOTO_IDS = ['p1', 'p2', 'p3', 'p4'];
const images = new Map<string, PhotoLayoutImage>(
  PHOTO_IDS.map((assetId) => [assetId, { assetId, src: TILE_PNG, width: 120, height: 80 }]),
);

/** Titles chosen to WRAP to 1, 2 and 4 lines at 26pt on these covers. The rendered line
 *  count is asserted per case, so a font change that alters the wrapping fails loudly
 *  instead of quietly turning the 4-line case back into a 2-line one. */
const TITLES = [
  { lines: 1, text: 'Omas Geburtstag' },
  { lines: 2, text: 'Zum achtzigsten Geburtstag unserer lieben Oma Margarete' },
  {
    lines: 4,
    text:
      'Zum achtzigsten Geburtstag unserer lieben Oma Margarete Wilhelmine Auguste, ' +
      'von ihren Kindern, Enkeln und Urenkeln aus Norddeutschland',
  },
] as const;

const TRIMS = [
  { name: 'hardcover-21x28', trim: { w: 210, h: 280 } },
  { name: 'hardcover-20x20', trim: { w: 200, h: 200 } },
] as const;

/** Gelato's real numbers for a 21×28 hardcover at 38 inner pages, and the same shape for a
 *  square book — the square one is the height-constrained case, where the title block's
 *  room comes out of the collage rather than out of slack. */
const SPREADS: ReadonlyArray<{ name: string; dims: GelatoCoverDimensions }> = [
  {
    name: 'hardcover-21x28',
    dims: {
      productUid: 'test-uid',
      pagesCount: 38,
      spread: { width: 468, height: 325, left: 0, top: 0 },
      contentBackSize: { width: 203, height: 285, left: 20, top: 20 },
      jointBackSize: { width: 8, height: 285, left: 223, top: 20 },
      spineSize: { width: 6, height: 285, left: 231, top: 20 },
      jointFrontSize: { width: 8, height: 285, left: 237, top: 20 },
      contentFrontSize: { width: 203, height: 285, left: 245, top: 20 },
    },
  },
  {
    name: 'hardcover-20x20',
    dims: {
      productUid: 'test-uid-square',
      pagesCount: 38,
      spread: { width: 448, height: 245, left: 0, top: 0 },
      contentBackSize: { width: 193, height: 205, left: 20, top: 20 },
      jointBackSize: { width: 8, height: 205, left: 213, top: 20 },
      spineSize: { width: 6, height: 205, left: 221, top: 20 },
      jointFrontSize: { width: 8, height: 205, left: 227, top: 20 },
      contentFrontSize: { width: 193, height: 205, left: 235, top: 20 },
    },
  },
];

function birthdayPlan(title: string, coverPhotos: number): PhotoBookPlan {
  return {
    kind: 'photo',
    template: 'birthday',
    style: 'classic',
    cover: {
      title,
      assetIds: PHOTO_IDS.slice(0, coverPhotos),
      heroAssetId: 'p1',
    },
    sections: [
      {
        title: 'Omas Geburtstag',
        storyId: 'story',
        pages: [{ template: 'full-framed', assetIds: ['p1'] }],
      },
    ],
  };
}

/** What one cover measured out at, in millimetres on the physical sheet. */
interface CoverMeasurement {
  /** Rendered line boxes of the `<h1>` — the wrap this case is actually testing. */
  titleLines: number;
  /** Collage bottom edge → title block top edge. Negative = they overlap. */
  clearanceMm: number;
  collageSideMm: number;
  /** Title block bottom edge → the sheet's own bottom edge. Negative = off the sheet. */
  titleToSheetMm: number;
  /** Widest and narrowest tile, so "the tiles are all one square" is measured, not assumed. */
  tileMinMm: number;
  tileMaxMm: number;
}

/** Measures a rendered cover in the page, given the collage/title/sheet selectors. */
async function measureCover(
  tab: Page,
  selectors: { sheet: string; collage: string; title: string },
): Promise<CoverMeasurement> {
  const raw = await tab.evaluate((sel) => {
    const pick = <T extends Element>(q: string): T => {
      const found = document.querySelector<T>(q);
      if (!found) throw new Error(`missing element: ${q}`);
      return found;
    };
    const sheet = pick(sel.sheet).getBoundingClientRect();
    const collageEl = pick(sel.collage);
    const collage = collageEl.getBoundingClientRect();
    const titleEl = pick(sel.title);
    const title = titleEl.getBoundingClientRect();
    const h1 = pick<HTMLElement>(`${sel.title} h1`);
    const range = document.createRange();
    range.selectNodeContents(h1);
    const tiles = Array.from(collageEl.querySelectorAll('.pb-birthday-cover-photo')).map((tile) => {
      const box = tile.getBoundingClientRect();
      return { w: box.width, h: box.height };
    });
    return {
      titleLines: range.getClientRects().length,
      clearancePx: title.top - collage.bottom,
      collageSidePx: collage.height,
      collageWidthPx: collage.width,
      titleToSheetPx: sheet.bottom - title.bottom,
      tiles,
    };
  }, selectors);

  const sides = raw.tiles.flatMap((t) => [t.w, t.h]);
  return {
    titleLines: raw.titleLines,
    clearanceMm: toMm(raw.clearancePx),
    collageSideMm: toMm(raw.collageSidePx),
    titleToSheetMm: toMm(raw.titleToSheetPx),
    tileMinMm: toMm(Math.min(...sides)),
    tileMaxMm: toMm(Math.max(...sides)),
  };
}

let browser: Browser;
let polyfill: Buffer;
/** Every measurement taken, printed once at the end as the evidence for this file. */
const report: string[] = [];

beforeAll(async () => {
  browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
  });
  polyfill = Buffer.from(await (await getPagedJsPolyfill()).arrayBuffer());
}, 120_000);

afterAll(async () => {
  await browser?.close();
  if (report.length > 0) console.log(`\ncover clearances (mm)\n${report.join('\n')}`);
});

/** Loads a document straight into a tab under the print cascade. */
async function openPrint(html: string): Promise<Page> {
  const tab = await browser.newPage();
  await tab.setViewport({ width: 2200, height: 1800 });
  await tab.emulateMediaType('print');
  await tab.setContent(html, { waitUntil: 'load' });
  await tab.evaluate(() => document.fonts.ready);
  return tab;
}

/** Loads the builder's real `screen` path, through the app's own Paged.js response. */
async function openScreen(html: string): Promise<Page> {
  const tab = await browser.newPage();
  await tab.setViewport({ width: 1600, height: 2000 });
  await tab.setRequestInterception(true);
  tab.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/') {
      void request.respond({ status: 200, contentType: 'text/html', body: html });
    } else if (url.pathname === '/api/pagedjs-polyfill') {
      void request.respond({ status: 200, contentType: 'text/javascript', body: polyfill });
    } else {
      void request.abort();
    }
  });
  await tab.goto('http://book.test/', { waitUntil: 'load' });
  await tab.waitForFunction(
    () => document.documentElement.getAttribute('data-pagedjs-ready') === 'true',
    { timeout: 30_000 },
  );
  return tab;
}

describe('Birthday cover: a long title can never print over the collage', () => {
  for (const { name, trim } of TRIMS) {
    it(
      `keeps the proof cover's title clear of the photos in every variant (${name})`,
      async () => {
        for (const variant of ['screen', 'preview', 'print'] as const) {
          for (const { lines, text } of TITLES) {
            const html = renderPhotoBookHtml({
              variant,
              chronicleName: 'Familie Muster',
              trim,
              plan: birthdayPlan(text, 4),
              images,
              fontFaceCss: embeddedFontFaceCss('classic'),
              createdLabel: 'August 2026',
              storyParagraphs: new Map(),
            });
            const tab = variant === 'screen' ? await openScreen(html) : await openPrint(html);
            let measured: CoverMeasurement;
            try {
              measured = await measureCover(tab, {
                sheet: '.pb-birthday-cover',
                collage: '.pb-birthday-cover-collage',
                title: '.pb-birthday-cover-text',
              });
            } finally {
              await tab.close();
            }
            const where = `proof ${name} ${variant} ${lines}-line`;
            report.push(
              `  ${where.padEnd(40)} clearance ${measured.clearanceMm.toFixed(2)}mm · ` +
                `square ${measured.collageSideMm.toFixed(2)}mm · ` +
                `tiles ${measured.tileMinMm.toFixed(2)}–${measured.tileMaxMm.toFixed(2)}mm · ` +
                `title→sheet ${measured.titleToSheetMm.toFixed(2)}mm`,
            );

            expect(measured.titleLines, `${where}: the title wrapped differently`).toBe(lines);
            // THE assertion this file exists for: the photos end above the title, always.
            expect(measured.clearanceMm, `${where}: title over the collage`).toBeGreaterThanOrEqual(
              -SLACK_MM,
            );
            // And the title itself is still on the sheet rather than pushed off it.
            expect(measured.titleToSheetMm, `${where}: title off the sheet`).toBeGreaterThanOrEqual(
              -SLACK_MM,
            );
            // Every tile is the same square, at every title length.
            expect(measured.tileMaxMm - measured.tileMinMm, `${where}: tiles differ`).toBeLessThan(0.1);
          }
        }
      },
      180_000,
    );
  }

  for (const { name, dims } of SPREADS) {
    it(
      `keeps the printed cover spread's title clear of the photos (${name})`,
      async () => {
        for (const { lines, text } of TITLES) {
          const html = renderCoverSpreadHtml({
            dims,
            plan: birthdayPlan(text, 4),
            chronicleName: 'Chronik Muster',
            createdLabel: 'August 2026',
            fontFaceCss: embeddedFontFaceCss('classic'),
            images,
          });
          const tab = await openPrint(html);
          let measured: CoverMeasurement;
          try {
            measured = await measureCover(tab, {
              sheet: '.pb-spread-front',
              collage: '.pb-spread-birthday-collage',
              title: '.pb-spread-birthday-text',
            });
          } finally {
            await tab.close();
          }
          const where = `spread ${name} ${lines}-line`;
          report.push(
            `  ${where.padEnd(40)} clearance ${measured.clearanceMm.toFixed(2)}mm · ` +
              `square ${measured.collageSideMm.toFixed(2)}mm · ` +
              `tiles ${measured.tileMinMm.toFixed(2)}–${measured.tileMaxMm.toFixed(2)}mm · ` +
              `title→panel ${measured.titleToSheetMm.toFixed(2)}mm`,
          );

          expect(measured.titleLines, `${where}: the title wrapped differently`).toBe(lines);
          expect(measured.clearanceMm, `${where}: title over the collage`).toBeGreaterThanOrEqual(
            -SLACK_MM,
          );
          expect(measured.titleToSheetMm, `${where}: title off the panel`).toBeGreaterThanOrEqual(
            -SLACK_MM,
          );
          expect(measured.tileMaxMm - measured.tileMinMm, `${where}: tiles differ`).toBeLessThan(0.1);
        }
      },
      180_000,
    );
  }

  it(
    'holds even for a title far longer than the reserve was estimated for',
    async () => {
      // The column layout — not the estimate — is what makes the overlap impossible, so
      // this drives the estimate past anything a real book would produce (`books.title` is
      // user-typed, so "absurd" is reachable) and checks the geometry still holds. The
      // title's reserve is capped at BIRTHDAY_COVER_TITLE_MAX_FRACTION of the cover, so the
      // collage keeps a usable floor and the runaway title wraps on past its own room
      // instead of shrinking the photographs to stamps.
      const absurd = `${'Ein wirklich unfassbar langer Geburtstagsbuchtitel '.repeat(6)}Ende`;
      for (const { name, trim } of TRIMS) {
        const html = renderPhotoBookHtml({
          variant: 'print',
          chronicleName: 'Familie Muster',
          trim,
          plan: birthdayPlan(absurd, 4),
          images,
          fontFaceCss: embeddedFontFaceCss('classic'),
          createdLabel: 'August 2026',
          storyParagraphs: new Map(),
        });
        const tab = await openPrint(html);
        let measured: CoverMeasurement;
        try {
          measured = await measureCover(tab, {
            sheet: '.pb-birthday-cover',
            collage: '.pb-birthday-cover-collage',
            title: '.pb-birthday-cover-text',
          });
        } finally {
          await tab.close();
        }
        report.push(
          `  ${`proof ${name} print ${measured.titleLines}-line (absurd)`.padEnd(40)} ` +
            `clearance ${measured.clearanceMm.toFixed(2)}mm · ` +
            `square ${measured.collageSideMm.toFixed(2)}mm · ` +
            `title→sheet ${measured.titleToSheetMm.toFixed(2)}mm`,
        );
        expect(measured.clearanceMm, `${name}: title over the collage`).toBeGreaterThanOrEqual(
          -SLACK_MM,
        );
        // Not merely "still prints": the photographs are the cover. Even here the collage
        // keeps more than 40% of the sheet's width (~94mm at 20×20, ~138mm at 21×28) —
        // before the cap it collapsed to 9.5mm, i.e. four ~2.8mm tiles.
        expect(measured.collageSideMm, `${name}: the collage keeps a usable floor`).toBeGreaterThan(
          trim.w * 0.4,
        );
      }
    },
    180_000,
  );
});

describe('Birthday cover: every photo count fills the same square', () => {
  /** 1 photo fills the square, 2 sit in one centred row, 3 put the odd tile under the
   *  middle of the other two, 4 are the plain 2×2 — all at ONE tile size (except the lone
   *  photo, which IS the square). Measured, because the arrangement is grid CSS, and the
   *  point of the change is what it looks like on paper. */
  for (const { name, trim } of TRIMS) {
    it(
      `arranges 1, 2, 3 and 4 cover photos symmetrically (${name})`,
      async () => {
        for (const count of [1, 2, 3, 4]) {
          const html = renderPhotoBookHtml({
            variant: 'print',
            chronicleName: 'Familie Muster',
            trim,
            plan: birthdayPlan('Omas Geburtstag', count),
            images,
            fontFaceCss: embeddedFontFaceCss('classic'),
            createdLabel: 'August 2026',
            storyParagraphs: new Map(),
          });
          const tab = await openPrint(html);
          let boxes: {
            collage: { left: number; right: number; top: number; bottom: number; side: number };
            tiles: Array<{ left: number; right: number; top: number; bottom: number; w: number; h: number }>;
          };
          try {
            boxes = await tab.evaluate(() => {
              const collageEl = document.querySelector('.pb-birthday-cover-collage')!;
              const c = collageEl.getBoundingClientRect();
              const rel = (b: DOMRect) => ({
                left: b.left - c.left,
                right: b.right - c.left,
                top: b.top - c.top,
                bottom: b.bottom - c.top,
                w: b.width,
                h: b.height,
              });
              return {
                collage: { left: 0, right: c.width, top: 0, bottom: c.height, side: c.width },
                tiles: Array.from(collageEl.querySelectorAll('.pb-birthday-cover-photo')).map((t) =>
                  rel(t.getBoundingClientRect()),
                ),
              };
            });
          } finally {
            await tab.close();
          }

          const where = `${name} ${count}-photo`;
          const side = toMm(boxes.collage.side);
          const tiles = boxes.tiles.map((t) => ({
            left: toMm(t.left),
            right: toMm(t.right),
            top: toMm(t.top),
            bottom: toMm(t.bottom),
            w: toMm(t.w),
            h: toMm(t.h),
          }));
          report.push(
            `  ${where.padEnd(40)} square ${side.toFixed(2)}mm · ` +
              `tiles ${tiles.map((t) => `${t.w.toFixed(2)}x${t.h.toFixed(2)}`).join(' ')}`,
          );

          expect(tiles, `${where}: tile count`).toHaveLength(count);
          for (const tile of tiles) {
            expect(Math.abs(tile.w - tile.h), `${where}: tile is square`).toBeLessThan(0.1);
          }
          // All the same size — and for the lone photo, that size is the whole square.
          const widths = tiles.map((t) => t.w);
          expect(Math.max(...widths) - Math.min(...widths), `${where}: one tile size`).toBeLessThan(0.1);
          if (count === 1) {
            expect(widths[0], `${where}: a lone photo fills the square`).toBeCloseTo(side, 1);
          } else {
            expect(widths[0], `${where}: a 2x2 cell`).toBeCloseTo((side - 4) / 2, 1);
          }
          // Symmetric within the square: the arrangement's own left and right margins
          // match, and so do its top and bottom.
          const leftGap = Math.min(...tiles.map((t) => t.left));
          const rightGap = side - Math.max(...tiles.map((t) => t.right));
          const topGap = Math.min(...tiles.map((t) => t.top));
          const bottomGap = side - Math.max(...tiles.map((t) => t.bottom));
          expect(Math.abs(leftGap - rightGap), `${where}: horizontally centred`).toBeLessThan(0.1);
          expect(Math.abs(topGap - bottomGap), `${where}: vertically centred`).toBeLessThan(0.1);
          // Three photos: the odd tile is centred under the gap between the first two.
          if (count === 3) {
            const third = tiles[2];
            expect(
              Math.abs((third.left + third.right) / 2 - side / 2),
              `${where}: the third tile is centred`,
            ).toBeLessThan(0.1);
            expect(third.top, `${where}: the third tile is on the second row`).toBeGreaterThan(
              tiles[0].bottom - 0.1,
            );
          }
        }
      },
      180_000,
    );
  }
});
