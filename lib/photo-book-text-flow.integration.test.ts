import puppeteer from 'puppeteer';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';

import { GET as getPagedJsPolyfill } from '@/app/api/pagedjs-polyfill/route';
import { renderPhotoBookHtml, type PhotoLayoutImage } from '@/lib/photo-book-layout';
import type { PhotoBookPlan } from '@/lib/photo-book-plan';

const PARAGRAPH_COUNT = 72;
const marker = (index: number) => `TEXTMARKER${String(index + 1).padStart(4, '0')}`;

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
      let screenPageCount = 0;
      let screenText = '';
      try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'load' });
        pdfBytes = await page.pdf({ printBackground: true, preferCSSPageSize: true });

        // Exercise the builder's real `screen` path too. It references the app's
        // self-hosted polyfill URL, so serve both the HTML and the exact response from
        // that route through a synthetic local origin rather than replacing Paged.js
        // with a test stub.
        const screenHtml = renderPhotoBookHtml({ ...input, variant: 'screen' });
        const polyfillResponse = await getPagedJsPolyfill();
        const polyfill = Buffer.from(await polyfillResponse.arrayBuffer());
        const screenPage = await browser.newPage();
        await screenPage.setRequestInterception(true);
        screenPage.on('request', (request) => {
          const url = new URL(request.url());
          if (url.pathname === '/') {
            void request.respond({ status: 200, contentType: 'text/html', body: screenHtml });
          } else if (url.pathname === '/api/pagedjs-polyfill') {
            void request.respond({ status: 200, contentType: 'text/javascript', body: polyfill });
          } else {
            void request.abort();
          }
        });
        await screenPage.goto('http://book.test/', { waitUntil: 'load' });
        await screenPage.waitForFunction(
          () => document.documentElement.getAttribute('data-pagedjs-ready') === 'true',
          { timeout: 30_000 },
        );
        ({ pageCount: screenPageCount, text: screenText } = await screenPage.evaluate(() => {
          const pages = document.querySelector('.pagedjs_pages');
          return {
            pageCount: pages?.querySelectorAll('.pagedjs_page').length ?? 0,
            text: pages?.textContent?.replace(/\s+/g, '') ?? '',
          };
        }));
      } finally {
        await browser.close();
      }

      expect(screenPageCount).toBeGreaterThan(7);
      for (let index = 0; index < PARAGRAPH_COUNT; index++) {
        expect(screenText.match(new RegExp(marker(index), 'g')) ?? [], marker(index)).toHaveLength(1);
      }

      const pdfDocument = await getDocument({ data: pdfBytes }).promise;
      expect(pdfDocument.numPages).toBeGreaterThan(7);
      const pageTexts: string[] = [];
      for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber++) {
        const page = await pdfDocument.getPage(pageNumber);
        const content = await page.getTextContent();
        pageTexts.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '));
      }
      await pdfDocument.destroy();

      // The first marker's drop cap is a separate PDF text item, so ignore extraction
      // whitespace while still requiring every complete, unique marker to survive.
      const extracted = pageTexts.join(' ').replace(/\s+/g, '');
      for (let index = 0; index < PARAGRAPH_COUNT; index++) {
        expect(extracted.match(new RegExp(marker(index), 'g')) ?? [], marker(index)).toHaveLength(1);
      }
    },
    30_000,
  );
});
