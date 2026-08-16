import { describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';

/**
 * Pure tests for the Gelato print file — no Chromium, no S3, no database. The PDFs are
 * built here with pdf-lib (differently sized pages so the assembled order can be asserted
 * by page size alone), and the cover spread is checked as HTML text, the same way
 * `lib/photo-book-layout.test.ts` checks the page renderer.
 *
 * `@/lib/env` is mocked for the same reason `lib/gelato.test.ts` mocks it: this module
 * imports `lib/gelato.ts` for MIN_PAGES/MAX_PAGES, and that file's import of the env
 * module would otherwise validate the whole process environment (DATABASE_URL, S3, …)
 * just to count pages.
 */
vi.mock('@/lib/env', () => ({ env: {} }));

import { assembleGelatoPdf, countGelatoInnerPages, gelatoInnerPageCount, renderCoverSpreadHtml, spineTextFor } from './book-print-file';
import type { GelatoCoverDimensions } from './gelato';
import type { PhotoBookPlan } from './photo-book-plan';

const COVER_W = 100;
const COVER_H = 200;
const INNER_W = 300;
const INNER_H = 400;
const SPREAD_W = 500;
const SPREAD_H = 600;

/** A stand-in for the worker's `print` variant: 2 cover pages then `inner` inner pages. */
async function printPdf(inner: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([COVER_W, COVER_H]); // front cover
  doc.addPage([COVER_W, COVER_H]); // back cover
  for (let i = 0; i < inner; i++) doc.addPage([INNER_W, INNER_H]);
  return Buffer.from(await doc.save());
}

async function spreadPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([SPREAD_W, SPREAD_H]);
  return Buffer.from(await doc.save());
}

async function pageSizes(pdf: Buffer): Promise<Array<{ width: number; height: number }>> {
  const doc = await PDFDocument.load(pdf);
  return doc.getPages().map((p) => {
    const { width, height } = p.getSize();
    return { width: Math.round(width), height: Math.round(height) };
  });
}

describe('gelatoInnerPageCount', () => {
  it('pads up to Gelato’s 30-page minimum', () => {
    expect(gelatoInnerPageCount(1)).toBe(30);
    expect(gelatoInnerPageCount(12)).toBe(30);
    expect(gelatoInnerPageCount(29)).toBe(30);
  });

  it('rounds an odd count up to an even one', () => {
    expect(gelatoInnerPageCount(31)).toBe(32);
    expect(gelatoInnerPageCount(101)).toBe(102);
  });

  it('leaves an even count at or above the minimum alone', () => {
    expect(gelatoInnerPageCount(30)).toBe(30);
    expect(gelatoInnerPageCount(64)).toBe(64);
  });
});

describe('countGelatoInnerPages', () => {
  it('ignores the print PDF’s two cover pages and applies the padding rule', async () => {
    expect(await countGelatoInnerPages(await printPdf(12))).toBe(30);
    expect(await countGelatoInnerPages(await printPdf(31))).toBe(32);
    expect(await countGelatoInnerPages(await printPdf(48))).toBe(48);
  });

  it('rejects a document that is nothing but its covers', async () => {
    await expect(countGelatoInnerPages(await printPdf(0))).rejects.toThrow(/no inner pages/);
  });
});

describe('assembleGelatoPdf', () => {
  it('orders the file as spread, endpaper, inner pages, endpaper', async () => {
    const { pdf, innerPageCount } = await assembleGelatoPdf({
      coverSpreadPdf: await spreadPdf(),
      printPdf: await printPdf(40),
    });
    expect(innerPageCount).toBe(40);

    const sizes = await pageSizes(pdf);
    // spread + leading endpaper + 40 inner + trailing endpaper
    expect(sizes).toHaveLength(43);
    expect(sizes[0]).toEqual({ width: SPREAD_W, height: SPREAD_H });
    for (const size of sizes.slice(1)) {
      expect(size).toEqual({ width: INNER_W, height: INNER_H });
    }
    // The print PDF's cover pages are gone — no page carries their size.
    expect(sizes.some((s) => s.width === COVER_W)).toBe(false);
  });

  it('pads a short book up to 30 inner pages with blanks of the inner size', async () => {
    const { pdf, innerPageCount } = await assembleGelatoPdf({
      coverSpreadPdf: await spreadPdf(),
      printPdf: await printPdf(12),
    });
    expect(innerPageCount).toBe(30);
    const sizes = await pageSizes(pdf);
    expect(sizes).toHaveLength(1 + 1 + 30 + 1);
    expect(sizes[sizes.length - 1]).toEqual({ width: INNER_W, height: INNER_H });
  });

  it('rounds an odd inner block up to an even one', async () => {
    const { pdf, innerPageCount } = await assembleGelatoPdf({
      coverSpreadPdf: await spreadPdf(),
      printPdf: await printPdf(31),
    });
    expect(innerPageCount).toBe(32);
    expect(await pageSizes(pdf)).toHaveLength(1 + 1 + 32 + 1);
  });

  it('refuses to build a file for a book with no inner pages', async () => {
    await expect(
      assembleGelatoPdf({ coverSpreadPdf: await spreadPdf(), printPdf: await printPdf(0) }),
    ).rejects.toThrow(/no inner pages/);
  });
});

/* ── cover spread ────────────────────────────────────────────────────────── */

/** Gelato's real numbers for a 21×28 hardcover at 38 inner pages (their docs' example). */
const HARDCOVER_DIMS: GelatoCoverDimensions = {
  productUid: 'test-uid',
  pagesCount: 38,
  spread: { width: 468, height: 325, left: 0, top: 0 },
  wraparoundInsideSize: { width: 468, height: 325, left: 0, top: 0 },
  contentBackSize: { width: 203, height: 285, left: 20, top: 20 },
  jointBackSize: { width: 8, height: 285, left: 223, top: 20 },
  spineSize: { width: 6, height: 285, left: 231, top: 20 },
  jointFrontSize: { width: 8, height: 285, left: 237, top: 20 },
  contentFrontSize: { width: 203, height: 285, left: 245, top: 20 },
};

function plan(overrides: Partial<PhotoBookPlan['cover']> = {}): PhotoBookPlan {
  return {
    version: 1,
    style: 'classic',
    cover: { title: 'Familie Müller', ...overrides },
    sections: [],
  } as unknown as PhotoBookPlan;
}

function spreadHtml(dims: GelatoCoverDimensions = HARDCOVER_DIMS, cover: Partial<PhotoBookPlan['cover']> = {}) {
  return renderCoverSpreadHtml({
    dims,
    plan: plan(cover),
    chronicleName: 'Chronik Müller',
    createdLabel: 'März 2026',
    fontFaceCss: '/* fonts */',
    images: new Map(),
  });
}

describe('renderCoverSpreadHtml', () => {
  it('sizes the page to the whole spread, with no margin', () => {
    const html = spreadHtml();
    expect(html).toContain('size: 468.00mm 325.00mm;');
    expect(html).toMatch(/@page\s*\{[^}]*margin: 0;/);
  });

  it('places back panel and spine at Gelato’s offsets', () => {
    const html = spreadHtml();
    expect(html).toContain('left: 20.00mm; top: 20.00mm; width: 203.00mm; height: 285.00mm;'); // back
    expect(html).toContain('left: 231.00mm; top: 20.00mm; width: 6.00mm; height: 285.00mm;'); // spine
  });

  it('keeps the front title inside the front panel, insetting past the wraparound', () => {
    const html = spreadHtml();
    // The title box spans the whole front half (so its scrim fades off the spread edges),
    // and pads the text back inside contentFrontSize: right = 468 - (245 + 203) + 8 = 28,
    // bottom = 325 - (20 + 285) + 8 + 4 = 32, left = the 8mm inset.
    expect(html).toContain('padding: 14mm 28.00mm 32.00mm 8.00mm;');
  });

  it('runs the back colour and the front half out to the spread edges', () => {
    const html = spreadHtml();
    // Back bleed: from the spread's left edge to the back panel's right edge (20 + 203),
    // full spread height.
    expect(html).toMatch(
      /\.pb-spread-back-bleed \{\s*left: 0; top: 0;\s*width: 223\.00mm;\s*height: 325\.00mm;\s*background: var\(--pb-cover-back-bg\);/,
    );
    // Front half: from the front panel's left edge (245) to the spread's right edge
    // (468 - 245 = 223), full spread height — the hero photo covers all of it.
    expect(html).toMatch(
      /\.pb-spread-front \{\s*left: 245\.00mm; top: 0;\s*width: 223\.00mm;\s*height: 325\.00mm;/,
    );
  });

  it('prints the title on the spine, reading top-to-bottom', () => {
    const html = spreadHtml();
    expect(html).toContain('writing-mode: vertical-rl;');
    expect(html).toContain('<span>Familie Müller · Chronik Müller</span>');
  });

  it('leaves a very thin spine blank', () => {
    const thin: GelatoCoverDimensions = {
      ...HARDCOVER_DIMS,
      spineSize: { ...HARDCOVER_DIMS.spineSize, width: 3 },
    };
    const html = spreadHtml(thin);
    expect(html).not.toContain('Familie Müller · Chronik Müller');
    expect(html).toMatch(/class="pb-spread-layer pb-spread-spine">\s*<\/div>/);
  });

  it('escapes text it prints', () => {
    const html = spreadHtml(HARDCOVER_DIMS, { title: 'A & <B>' });
    expect(html).toContain('<h1>A &amp; &lt;B&gt;</h1>');
  });
});

describe('spineTextFor', () => {
  const spine = { width: 6, height: 285, left: 0, top: 0 };

  it('drops the chronicle name when the spine is too short for both', () => {
    const fitted = spineTextFor({ spine: { ...spine, height: 90 }, title: 'Familie Müller', chronicleName: 'Eine sehr lange Chronik der Familie' });
    expect(fitted?.text).toBe('Familie Müller');
  });

  it('truncates a title that cannot fit at all', () => {
    const fitted = spineTextFor({ spine: { ...spine, height: 40 }, title: 'Ein wirklich sehr langer Buchtitel', chronicleName: '' });
    expect(fitted?.text.endsWith('…')).toBe(true);
    expect(fitted!.text.length).toBeLessThan('Ein wirklich sehr langer Buchtitel'.length);
  });

  it('returns nothing for a thin spine or an empty title', () => {
    expect(spineTextFor({ spine: { ...spine, width: 4.9 }, title: 'T', chronicleName: 'C' })).toBeNull();
    expect(spineTextFor({ spine, title: '   ', chronicleName: 'C' })).toBeNull();
  });
});
