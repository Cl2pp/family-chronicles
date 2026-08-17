import puppeteer, { type Browser, type Page } from 'puppeteer';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';

import { GET as getPagedJsPolyfill } from '@/app/api/pagedjs-polyfill/route';
import { renderPhotoBookHtml, type PhotoLayoutImage } from '@/lib/photo-book-layout';
import type { PhotoBookPlan } from '@/lib/photo-book-plan';

const PARAGRAPH_COUNT = 72;
const marker = (index: number) => `TEXTMARKER${String(index + 1).padStart(4, '0')}`;

/**
 * The builder's iframe is small, so the `screen` variant zooms the page stack down to
 * fit. Both sizes must paginate identically: the zoom is presentation only, and the
 * builder's page count and page breaks have to be the ones the print file will have.
 */
const SCREEN_VIEWPORTS = [
  { label: 'desktop-sized viewport (no zoom)', width: 1400, height: 1800 },
  { label: 'builder-sized iframe (zoomed down)', width: 480, height: 660 },
];

/**
 * Which markers each rendered page actually SHOWS. Text that Paged.js pushed past the
 * sheet is still in `textContent` but sits outside the page box and is clipped away, so
 * containment — not text presence — is what tells us the reader can see it.
 */
async function visibleMarkersPerScreenPage(page: Page): Promise<number[][]> {
  return page.evaluate(() => {
    const pattern = /TEXTMARKER(\d{4})/g;
    return Array.from(document.querySelectorAll('.pagedjs_page')).map((sheet) => {
      const box = sheet.getBoundingClientRect();
      const visible: number[] = [];
      const walker = document.createTreeWalker(sheet, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.nodeValue ?? '';
        pattern.lastIndex = 0;
        for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
          const range = document.createRange();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);
          const rect = range.getBoundingClientRect();
          if (rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1) {
            visible.push(Number(match[1]));
          }
        }
      }
      return visible;
    });
  });
}

type PageFit = {
  pageWidth: number;
  pageHeight: number;
  availWidth: number;
  availHeight: number;
  visibility: string;
};

/** How big one rendered sheet ends up next to the space the viewport actually offers —
 *  plus whether it is actually on screen. The stack is hidden until Paged.js finishes, and
 *  `getBoundingClientRect` reports boxes for hidden elements just the same, so a preview
 *  left permanently invisible would satisfy every size assertion below without this. */
async function measurePageFit(page: Page): Promise<PageFit> {
  return page.evaluate(async () => {
    // ResizeObserver callbacks land before paint, so two frames is enough for a viewport
    // change to have been turned into a new zoom.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const sheet = document.querySelector('.pagedjs_page');
    const rect = sheet?.getBoundingClientRect();
    return {
      pageWidth: rect?.width ?? 0,
      pageHeight: rect?.height ?? 0,
      availWidth: document.documentElement.clientWidth,
      availHeight: document.documentElement.clientHeight,
      visibility: sheet ? getComputedStyle(sheet).visibility : 'missing',
    };
  });
}

async function markersPerPdfPage(pdfBytes: Uint8Array): Promise<number[][]> {
  const pdfDocument = await getDocument({ data: pdfBytes }).promise;
  const perPage: number[][] = [];
  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber++) {
    const page = await pdfDocument.getPage(pageNumber);
    const content = await page.getTextContent();
    // The first marker's drop cap is a separate PDF text item, so ignore extraction
    // whitespace while still reading every complete marker. Stripping per page rather than
    // over the whole document is what makes the markers attributable to a page at all;
    // safe here because a marker is one unhyphenated word at the very start of a paragraph
    // and so never straddles a page break.
    const text = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
      .replace(/\s+/g, '');
    perPage.push(Array.from(text.matchAll(/TEXTMARKER(\d{4})/g), (match) => Number(match[1])));
  }
  await pdfDocument.destroy();
  return perPage;
}

async function openScreenPage(
  browser: Browser,
  html: string,
  polyfill: Buffer,
  viewport: { width: number; height: number },
): Promise<Page> {
  // The `screen` variant references the app's self-hosted polyfill URL, so serve both the
  // HTML and the exact response from that route through a synthetic local origin rather
  // than replacing Paged.js with a test stub. (The one exception is the failure case at the
  // bottom of this file, which has to stand in for a Paged.js that dies mid-run.)
  const page = await browser.newPage();
  // Size the viewport before loading: Paged.js paginates on load, and the fit-to-iframe
  // zoom is driven by the viewport it sees while doing so.
  await page.setViewport(viewport);
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/') {
      void request.respond({ status: 200, contentType: 'text/html', body: html });
    } else if (url.pathname === '/api/pagedjs-polyfill') {
      void request.respond({ status: 200, contentType: 'text/javascript', body: polyfill });
    } else {
      void request.abort();
    }
  });
  await page.goto('http://book.test/', { waitUntil: 'load' });
  await page.waitForFunction(
    () => document.documentElement.getAttribute('data-pagedjs-ready') === 'true',
    { timeout: 30_000 },
  );
  return page;
}

describe('flowing story text PDF pagination', () => {
  it(
    'keeps every paragraph when long text runs span pages on both sides of a photo page',
    async () => {
      const prose =
        'Es war ein Sommer, wie ihn nur die Erinnerung kennt: lang, golden und voller Stimmen. ' +
        'Jeden Morgen roch es nach Kaffee und frisch gemähtem Gras.';
      const paragraphs = Array.from(
        { length: PARAGRAPH_COUNT },
        (_, index) => `${marker(index)} ${prose}`,
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
              { template: 'full-bleed', assetIds: ['photo'] },
              { template: 'text', from: 48, to: PARAGRAPH_COUNT - 1 },
            ],
          },
        ],
      };
      const photo: PhotoLayoutImage = {
        assetId: 'photo',
        src:
          'data:image/svg+xml;base64,' +
          Buffer.from(
            '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="100%" height="100%" fill="#ddd"/></svg>',
          ).toString('base64'),
        width: 1200,
        height: 800,
      };
      const input = {
        variant: 'print',
        chronicleName: 'Familie Muster',
        trim: { w: 210, h: 280 },
        plan,
        images: new Map([[photo.assetId, photo]]),
        fontFaceCss: '',
        createdLabel: 'August 2026',
        storyParagraphs: new Map([['story', paragraphs]]),
      } as const;
      const html = renderPhotoBookHtml(input);

      const browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
      });
      let pdfBytes: Uint8Array;
      const screenRuns: {
        label: string;
        pageCount: number;
        text: string;
        visible: number[][];
        fit: PageFit;
        refit: PageFit;
        pageCountAfterResize: number;
      }[] = [];
      try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'load' });
        pdfBytes = await page.pdf({ printBackground: true, preferCSSPageSize: true });
        // Closed so each screen page below is the foreground tab: `measurePageFit` waits on
        // animation frames, which a backgrounded tab throttles.
        await page.close();

        // Exercise the builder's real `screen` path too, at both a roomy viewport and one
        // small enough that the fit-to-iframe zoom kicks in.
        const screenHtml = renderPhotoBookHtml({ ...input, variant: 'screen' });
        const polyfillResponse = await getPagedJsPolyfill();
        const polyfill = Buffer.from(await polyfillResponse.arrayBuffer());
        for (const viewport of SCREEN_VIEWPORTS) {
          const measured = await openScreenPage(browser, screenHtml, polyfill, viewport);
          const { pageCount, text } = await measured.evaluate(() => {
            const pages = document.querySelector('.pagedjs_pages');
            return {
              pageCount: pages?.querySelectorAll('.pagedjs_page').length ?? 0,
              text: pages?.textContent?.replace(/\s+/g, '') ?? '',
            };
          });
          const visible = await visibleMarkersPerScreenPage(measured);
          const fit = await measurePageFit(measured);
          // Gating the zoom on "Paged.js is done" must not disable the fitting itself:
          // a later viewport change still has to refit the stack.
          await measured.setViewport({
            width: Math.round(viewport.width * 0.75),
            height: Math.round(viewport.height * 0.75),
          });
          const refit = await measurePageFit(measured);
          const pageCountAfterResize = await measured.evaluate(
            () => document.querySelectorAll('.pagedjs_page').length,
          );
          screenRuns.push({
            label: viewport.label,
            pageCount,
            text,
            visible,
            fit,
            refit,
            pageCountAfterResize,
          });
          await measured.close();
        }
      } finally {
        await browser.close();
      }

      // The invariant the bug actually broke, and the one assertion that can never drift:
      // both viewports run the same engine over the same document, so zooming to fit must
      // not move a single paragraph. The comparison against Chromium's own print
      // fragmentation below is the looser cross-check on top of it.
      const [unzoomed, zoomed] = screenRuns;
      expect(zoomed.visible, `${zoomed.label} vs ${unzoomed.label}`).toEqual(unzoomed.visible);

      const pdfMarkers = await markersPerPdfPage(pdfBytes);
      expect(pdfMarkers.length).toBeGreaterThan(7);
      const printedMarkers = pdfMarkers.flat();
      expect(printedMarkers).toEqual(
        Array.from({ length: PARAGRAPH_COUNT }, (_, index) => index + 1),
      );

      for (const run of screenRuns) {
        expect(run.pageCount, run.label).toBe(pdfMarkers.length);
        for (let index = 0; index < PARAGRAPH_COUNT; index++) {
          expect(run.text.match(new RegExp(marker(index), 'g')) ?? [], `${run.label} ${marker(index)}`).toHaveLength(1);
        }
        // Page for page, the builder must show exactly what the print file prints —
        // nothing pushed off the sheet and clipped away.
        expect(run.visible, run.label).toEqual(pdfMarkers);

        // A whole sheet still has to fit the viewport, before and after a resize, and
        // resizing must not re-paginate. Only the small viewport exercises the fitting: at
        // 1400x1800 a page fits at native size, so its zoom stays 1 either way.
        for (const [when, fit] of [
          ['initial', run.fit],
          ['after resize', run.refit],
        ] as const) {
          expect(fit.visibility, `${run.label} ${when} visibility`).toBe('visible');
          expect(fit.pageWidth, `${run.label} ${when} width`).toBeGreaterThan(0);
          expect(fit.pageWidth, `${run.label} ${when} width`).toBeLessThanOrEqual(
            fit.availWidth + 1,
          );
          expect(fit.pageHeight, `${run.label} ${when} height`).toBeLessThanOrEqual(
            fit.availHeight + 1,
          );
        }
        expect(run.pageCountAfterResize, `${run.label} after resize`).toBe(pdfMarkers.length);
      }
    },
    120_000,
  );
});

describe('builder preview when Paged.js dies mid-run', () => {
  it(
    'still reveals and fits whatever was laid out',
    async () => {
      // The page stack is hidden until pagination reports done, so a Paged.js that builds
      // some pages and then throws would otherwise leave the builder staring at an empty
      // box forever. Paged.js never catches its own bootstrap promise, so the failure
      // arrives as an unhandled rejection — stood in for here by a stub that appends a page
      // stack and then rejects, since a real Paged.js failure can't be provoked on demand.
      const html = renderPhotoBookHtml({
        variant: 'screen',
        chronicleName: 'Familie Muster',
        trim: { w: 210, h: 280 },
        plan: {
          kind: 'photo',
          style: 'classic',
          cover: { title: 'Geburtstagsbuch' },
          sections: [{ title: 'Eine Geschichte', storyId: 'story', pages: [] }],
        },
        images: new Map(),
        fontFaceCss: '',
        createdLabel: 'August 2026',
        storyParagraphs: new Map([['story', ['Ein Absatz.']]]),
      });
      // Deferred to DOM-ready for the same reason the real polyfill is: this script tag
      // sits in <head>, so there is no <body> to append to when it first runs.
      const brokenPolyfill = `
        document.addEventListener('DOMContentLoaded', function () {
          var pages = document.createElement('div');
          pages.className = 'pagedjs_pages';
          var sheet = document.createElement('div');
          sheet.className = 'pagedjs_page';
          pages.appendChild(sheet);
          document.body.appendChild(pages);
          Promise.reject(new Error('pagination blew up'));
        });
      `;

      const browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
      });
      try {
        const page = await openScreenPage(browser, html, Buffer.from(brokenPolyfill), {
          width: 480,
          height: 660,
        });
        const { visibility, zoom } = await page.evaluate(() => {
          const pages = document.querySelector('.pagedjs_pages') as HTMLElement | null;
          return {
            visibility: pages ? getComputedStyle(pages).visibility : 'missing',
            zoom: pages?.style.zoom ?? '',
          };
        });
        expect(visibility).toBe('visible');
        expect(Number(zoom)).toBeGreaterThan(0);
        expect(Number(zoom)).toBeLessThan(1);
      } finally {
        await browser.close();
      }
    },
    60_000,
  );
});
