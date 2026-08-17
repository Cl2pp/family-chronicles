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

type PageFit = { pageWidth: number; pageHeight: number; availWidth: number; availHeight: number };

/** How big one rendered sheet ends up next to the space the viewport actually offers. */
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
    // whitespace while still requiring every complete, unique marker to survive.
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
  // than replacing Paged.js with a test stub.
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
        // resizing must not re-paginate.
        for (const [when, fit] of [
          ['initial', run.fit],
          ['after resize', run.refit],
        ] as const) {
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
