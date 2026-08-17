import puppeteer, { type Browser } from 'puppeteer';
import sharp from 'sharp';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GET as getPagedJsPolyfill } from '@/app/api/pagedjs-polyfill/route';
import { renderPhotoBookHtml, type PhotoLayoutImage, type PhotoLayoutInput } from '@/lib/photo-book-layout';
import type { PhotoBookPlan } from '@/lib/photo-book-plan';

/**
 * Pagination is the one thing about this renderer that cannot be reasoned about from its
 * CSS: WHERE a page breaks is the print engine's decision, and there are two engines that
 * have to agree — Chromium's own (the `preview`/`print` PDFs, and the page count Gelato is
 * ordered against) and the Paged.js polyfill behind the builder's live `screen` preview. So
 * these tests render real documents headlessly and measure which physical page every
 * element actually landed on, in BOTH engines, at both trim sizes.
 */

const PARAGRAPH_COUNT = 72;
const marker = (index: number) => `TEXTMARKER${String(index + 1).padStart(4, '0')}`;
const markersIn = (text: string) => text.match(/TEXTMARKER\d{4}/g) ?? [];

const PROSE =
  'Es war ein Sommer, wie ihn nur die Erinnerung kennt: lang, golden und voller Stimmen. ' +
  'Jeden Morgen roch es nach Kaffee und frisch gemähtem Gras.';

/** ~30 words — the birthday-message case the shared-photo layout exists for. */
const SHORT_STORY = [
  `${marker(0)} Liebe Oma, danke für jeden Sonntagnachmittag in deiner Küche, für den Kuchen, ` +
    'die Geschichten und dafür, dass du immer zugehört hast. Alles Gute!',
];

const TRIMS = [
  { name: 'hardcover-21x28', trim: { w: 210, h: 280 } },
  { name: 'hardcover-20x20', trim: { w: 200, h: 200 } },
] as const;

const PHOTO_IDS = ['p1', 'p2', 'p3', 'p4', 'p5'];

/** What one physical page of a rendered document contains. */
interface RenderedPage {
  /** All of the page's text, whitespace stripped — enough to locate a TEXTMARKER. */
  text: string;
  /** Whether the page paints any photo. Deliberately a boolean and not a count: Chromium
   *  rasterises a CSS box-shadow into its own image XObject, so a matted single photo is
   *  two image paints in the PDF and one `<img>` in the DOM. */
  photos: boolean;
}

let browser: Browser;
let polyfill: Buffer;
let images: Map<string, PhotoLayoutImage>;

beforeAll(async () => {
  browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
  });
  polyfill = Buffer.from(await (await getPagedJsPolyfill()).arrayBuffer());
  // Real (if tiny) PNGs, not SVG data URIs: Chromium embeds an SVG image into the PDF as
  // vector drawing operations, which no image-paint op would then account for.
  const png = await sharp({
    create: { width: 120, height: 80, channels: 3, background: { r: 200, g: 210, b: 220 } },
  })
    .png()
    .toBuffer();
  images = new Map(
    PHOTO_IDS.map((assetId) => [
      assetId,
      { assetId, src: `data:image/png;base64,${png.toString('base64')}`, width: 120, height: 80 },
    ]),
  );
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

/** Renders the `print` variant through Chromium's own print engine and reads the resulting
 *  PDF back page by page — the exact path `render-book` takes for the order-time proof. */
async function renderPrintPages(input: PhotoLayoutInput): Promise<RenderedPage[]> {
  const tab = await browser.newPage();
  let pdfBytes: Uint8Array;
  try {
    await tab.setContent(renderPhotoBookHtml(input), { waitUntil: 'load' });
    pdfBytes = await tab.pdf({ printBackground: true, preferCSSPageSize: true });
  } finally {
    await tab.close();
  }
  const pdf = await getDocument({ data: pdfBytes }).promise;
  const pages: RenderedPage[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const pdfPage = await pdf.getPage(pageNumber);
    const content = await pdfPage.getTextContent();
    const ops = await pdfPage.getOperatorList();
    pages.push({
      // A drop cap is its own PDF text item, so ignore extraction whitespace while still
      // requiring every complete, unique marker to survive.
      text: content.items.map((item) => ('str' in item ? item.str : '')).join(' ').replace(/\s+/g, ''),
      // Every image-painting op pdf.js can emit. (There is no `paintJpegXObject` — a JPEG
      // XObject is painted by `paintImageXObject` like any other.)
      photos: ops.fnArray.some(
        (fn) =>
          fn === OPS.paintImageXObject ||
          fn === OPS.paintImageXObjectRepeat ||
          fn === OPS.paintInlineImageXObject ||
          fn === OPS.paintInlineImageXObjectGroup,
      ),
    });
  }
  await pdf.destroy();
  return pages;
}

/** Renders the builder's real `screen` path — the app's own self-hosted Paged.js response,
 *  served through a synthetic local origin rather than replaced with a test stub — and
 *  measures the paginated DOM. `overflows` names every paragraph or photo whose box leaves
 *  its page's content area, which is also where the folio's margin box begins. */
async function renderScreenPages(
  input: PhotoLayoutInput,
): Promise<{ pages: RenderedPage[]; overflows: string[] }> {
  const html = renderPhotoBookHtml({ ...input, variant: 'screen' });
  const tab = await browser.newPage();
  try {
    // Big enough that the preview's own zoom-to-fit chrome stays at 1:1 — this test is
    // about where the RENDERER breaks pages, not about how the builder scales the result
    // into its iframe.
    await tab.setViewport({ width: 1400, height: 1800 });
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
    return await tab.evaluate(() => {
      const overflows: string[] = [];
      const pages = Array.from(document.querySelectorAll('.pagedjs_page')).map((sheet, index) => {
        const area = (sheet.querySelector('.pagedjs_area') ?? sheet).getBoundingClientRect();
        for (const element of Array.from(sheet.querySelectorAll('p, img'))) {
          const box = element.getBoundingClientRect();
          if (box.width === 0 && box.height === 0) continue;
          // 1px of slack: sub-pixel rounding, not a layout defect.
          if (
            box.top < area.top - 1 ||
            box.bottom > area.bottom + 1 ||
            box.left < area.left - 1 ||
            box.right > area.right + 1
          ) {
            overflows.push(`page ${index + 1}: <${element.tagName.toLowerCase()}> leaves the content area`);
          }
        }
        return {
          text: sheet.textContent?.replace(/\s+/g, '') ?? '',
          photos: sheet.querySelectorAll('img').length > 0,
        };
      });
      return { pages, overflows };
    });
  } finally {
    await tab.close();
  }
}

function layoutInput(
  plan: PhotoBookPlan,
  trim: { w: number; h: number },
  paragraphs: string[],
): PhotoLayoutInput {
  return {
    variant: 'print',
    chronicleName: 'Familie Muster',
    trim,
    plan,
    images,
    fontFaceCss: '',
    createdLabel: 'August 2026',
    storyParagraphs: new Map([['story', paragraphs]]),
  };
}

/** The 1-based page a marker landed on, or 0 when it is missing entirely. */
function pageOf(pages: RenderedPage[], needle: string): number {
  return pages.findIndex((page) => page.text.includes(needle)) + 1;
}

/**
 * The document reduced to what the two engines MUST agree on, page by page: which
 * paragraphs a page carries and whether it carries photos.
 *
 * Blank pages are dropped first, because there is one long-standing difference between the
 * engines that this feature neither introduces nor fixes: Paged.js inserts the parity sheet
 * a Birthday chapter's `break-before: left` asks for, Chromium's `page.pdf()` does not. So
 * the print PDF runs exactly one sheet shorter here; everything else has to match.
 */
function pageSignatures(pages: RenderedPage[]): string[] {
  return pages
    .filter((page) => page.text.length > 0 || page.photos)
    .map((page) => {
      const markers = markersIn(page.text);
      const range = markers.length > 0 ? `${markers[0]}..${markers[markers.length - 1]}` : 'no-text';
      return `${range} ${page.photos ? 'with-photos' : 'text-only'}`;
    });
}

/** Every marker appears exactly once across the whole document — the guard against a long
 *  birthday message being silently clipped or dropped. */
function expectEveryParagraph(pages: RenderedPage[], count: number, engine: string) {
  const all = pages.map((page) => page.text).join('');
  for (let index = 0; index < count; index++) {
    expect(all.match(new RegExp(marker(index), 'g')) ?? [], `${engine} ${marker(index)}`).toHaveLength(1);
  }
}

describe('flowing story text PDF pagination', () => {
  it(
    'keeps every paragraph when long text runs span pages on both sides of a photo page',
    async () => {
      const paragraphs = Array.from(
        { length: PARAGRAPH_COUNT },
        (_, index) => `${marker(index)} ${PROSE}`,
      );
      const plan: PhotoBookPlan = {
        kind: 'photo',
        style: 'classic',
        cover: { title: 'Geburtstagsbuch' },
        sections: [
          {
            title: 'Eine lange Geschichte',
            storyId: 'story',
            pages: [
              { template: 'text', from: 0, to: 47 },
              { template: 'full-bleed', assetIds: ['p1'] },
              { template: 'text', from: 48, to: PARAGRAPH_COUNT - 1 },
            ],
          },
        ],
      };
      const input = layoutInput(plan, { w: 210, h: 280 }, paragraphs);

      const printPages = await renderPrintPages(input);
      const { pages: screenPages, overflows } = await renderScreenPages(input);

      expect(overflows).toEqual([]);
      expect(screenPages.length).toBeGreaterThan(7);
      expect(printPages.length).toBeGreaterThan(7);
      expectEveryParagraph(printPages, PARAGRAPH_COUNT, 'print');
      expectEveryParagraph(screenPages, PARAGRAPH_COUNT, 'screen');
    },
    120_000,
  );
});

/**
 * The Birthday recipe tells a story in full and then shows its photos. When the story is
 * three lines long that used to leave ~90% of a sheet empty with the photos stranded on the
 * next one; the renderer now hands the chapter's first photo group to the text flow itself
 * (`.pb-shared-photos`) and lets each engine decide whether it still fits there.
 */
describe('Birthday chapter: a short story shares its page with its photos', () => {
  /** One chapter: its prose, then a four-photo group, then a single-photo page. */
  function birthdayPlan(paragraphCount: number): PhotoBookPlan {
    return {
      kind: 'photo',
      template: 'birthday',
      style: 'classic',
      cover: { title: 'Geburtstagsbuch', assetIds: ['p1'], heroAssetId: 'p1' },
      sections: [
        {
          title: 'Omas Geburtstag',
          storyId: 'story',
          pages: [
            { template: 'text', from: 0, to: paragraphCount - 1 },
            { template: 'four-mixed', assetIds: ['p1', 'p2', 'p3', 'p4'] },
            { template: 'full-framed', assetIds: ['p5'] },
          ],
        },
      ],
    };
  }

  for (const { name, trim } of TRIMS) {
    it(
      `puts a very short story's photos on the story's own page (${name})`,
      async () => {
        const input = layoutInput(birthdayPlan(SHORT_STORY.length), trim, SHORT_STORY);

        const printPages = await renderPrintPages(input);
        const { pages: screenPages, overflows } = await renderScreenPages(input);

        expect(overflows).toEqual([]);
        expect(pageSignatures(screenPages)).toEqual(pageSignatures(printPages));

        for (const [engine, pages] of [
          ['print', printPages],
          ['screen', screenPages],
        ] as const) {
          const storyPage = pageOf(pages, marker(0));
          expect(storyPage, `${engine}: story text is missing`).toBeGreaterThan(0);
          // The four-photo group rode along under the prose instead of taking the next
          // sheet, and the chapter's remaining photo page still follows on its own.
          expect(pages[storyPage - 1].photos, `${engine}: photos beside the prose`).toBe(true);
          expect(pages[storyPage].photos, `${engine}: the following photo page`).toBe(true);
          expect(pages.length, `${engine}: nothing after the last photo page`).toBe(storyPage + 1);
        }
      },
      120_000,
    );

    it(
      `keeps a medium story's photos off its page (${name})`,
      async () => {
        // ~430 words: comfortably past the shared-page budget at either trim.
        const paragraphs = Array.from({ length: 12 }, (_, index) => `${marker(index)} ${PROSE}`);
        const input = layoutInput(birthdayPlan(paragraphs.length), trim, paragraphs);

        const printPages = await renderPrintPages(input);
        const { pages: screenPages, overflows } = await renderScreenPages(input);

        expect(overflows).toEqual([]);
        expect(pageSignatures(screenPages)).toEqual(pageSignatures(printPages));

        for (const [engine, pages] of [
          ['print', printPages],
          ['screen', screenPages],
        ] as const) {
          expectEveryParagraph(pages, paragraphs.length, engine);
          const lastTextPage = pageOf(pages, marker(paragraphs.length - 1));
          for (let page = pageOf(pages, marker(0)); page <= lastTextPage; page++) {
            expect(pages[page - 1].photos, `${engine}: no photos beside the prose`).toBe(false);
          }
          expect(pages[lastTextPage].photos, `${engine}: photos on the next sheet`).toBe(true);
        }
      },
      120_000,
    );

    it(
      `keeps a long story's text whole and its photos after it (${name})`,
      async () => {
        const paragraphs = Array.from(
          { length: PARAGRAPH_COUNT },
          (_, index) => `${marker(index)} ${PROSE}`,
        );
        const input = layoutInput(birthdayPlan(paragraphs.length), trim, paragraphs);

        const printPages = await renderPrintPages(input);
        const { pages: screenPages, overflows } = await renderScreenPages(input);

        expect(overflows).toEqual([]);
        expect(pageSignatures(screenPages)).toEqual(pageSignatures(printPages));

        for (const [engine, pages] of [
          ['print', printPages],
          ['screen', screenPages],
        ] as const) {
          expectEveryParagraph(pages, PARAGRAPH_COUNT, engine);
          // Prose spans several sheets, and every photo comes after the last of them.
          const firstTextPage = pageOf(pages, marker(0));
          const lastTextPage = pageOf(pages, marker(PARAGRAPH_COUNT - 1));
          expect(lastTextPage, `${engine}: text spans pages`).toBeGreaterThan(firstTextPage);
          const firstPhotoPage = pages.findIndex((page, index) => index >= firstTextPage - 1 && page.photos) + 1;
          expect(firstPhotoPage, `${engine}: photos follow the prose`).toBe(lastTextPage + 1);
        }
      },
      120_000,
    );
  }
});
