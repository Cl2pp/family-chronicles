import { writeFileSync } from 'node:fs';
import { renderPhotoBookHtml, type PhotoLayoutImage } from '@/lib/photo-book-layout';
import type { PhotoBookPlan } from '@/lib/photo-book-plan';
import { screenFontFaceCss } from '@/lib/photo-book-fonts';

/**
 * Dev-only sanity render for the UNIFIED book (story text + photo pages): writes a
 * static HTML file of a plan whose sections carry `storyId` + flowing `text` items,
 * with placeholder photos — for eyeballing the text-flow pagination, drop caps, TOC
 * and page numbers in any browser (or printing it to PDF via Chromium).
 *
 *   npx tsx scripts/render-unified-book-sample.ts /tmp/unified-book.html [print|screen]
 */

function svgImage(assetId: string, w: number, h: number, color: string): PhotoLayoutImage {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${color}"/><text x="50%" y="52%" font-size="${Math.round(h / 6)}" fill="#fff" text-anchor="middle" font-family="sans-serif">${assetId}</text></svg>`;
  return { assetId, src: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, width: w, height: h };
}

const images = new Map(
  [
    svgImage('hero', 1600, 1067, '#4a6741'),
    svgImage('l1', 1600, 1067, '#8a5a44'),
    svgImage('p1', 1000, 1500, '#356060'),
    svgImage('p2', 1000, 1500, '#603535'),
  ].map((i) => [i.assetId, i]),
);

const LOREM =
  'Es war ein Sommer, wie ihn nur die Erinnerung kennt: lang, golden und voller Stimmen. Jeden Morgen roch es nach Kaffee und frisch gemähtem Gras, und irgendwo klapperte immer eine Tür.';
const paragraphs = Array.from({ length: 24 }, (_, i) => `Absatz ${i + 1}. ${LOREM}`);

const plan: PhotoBookPlan = {
  kind: 'photo',
  style: 'classic',
  cover: { heroAssetId: 'hero', title: 'Familie Muster', subtitle: 'Erinnerungen' },
  sections: [
    {
      title: 'Omas Sommer',
      dateLabel: '1962',
      storyId: 's1',
      pages: [
        { template: 'text', from: 0, to: 9 },
        { template: 'two-vertical', assetIds: ['p1', 'p2'] },
        { template: 'text', from: 10, to: 23 },
        { template: 'full-bleed', assetIds: ['l1'] },
      ],
    },
  ],
};

const variant = (process.argv[3] as 'print' | 'screen') ?? 'print';
const html = renderPhotoBookHtml({
  variant,
  chronicleName: 'Familie Muster',
  trim: { w: 210, h: 280 },
  plan,
  images,
  fontFaceCss: screenFontFaceCss('classic'),
  createdLabel: 'Juli 2026',
  storyParagraphs: new Map([['s1', paragraphs]]),
  language: 'de',
});

const out = process.argv[2] ?? '/tmp/unified-book-sample.html';
writeFileSync(out, html);
console.log(`wrote ${out} (${variant})`);
