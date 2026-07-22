import { writeFileSync } from 'node:fs';
import { renderPhotoBookHtml, type PhotoLayoutImage } from '@/lib/photo-book-layout';
import type { PhotoBookPlan } from '@/lib/photo-book-plan';
import { screenFontFaceCss } from '@/lib/photo-book-fonts';

/**
 * Dev-only sanity render: writes a static HTML file of a sample photo-book plan (print
 * variant — no Paged.js needed, every page is its own fixed-size section) with colored
 * SVG placeholder photos at realistic aspect ratios, so template-geometry changes can be
 * eyeballed in any browser without a database, S3, or Chromium.
 *
 *   npx tsx scripts/render-photo-book-sample.ts /tmp/book.html
 */

function svgImage(assetId: string, w: number, h: number, color: string): PhotoLayoutImage {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${color}"/><rect x="4%" y="4%" width="92%" height="92%" fill="none" stroke="#fff" stroke-width="${Math.round(w / 60)}"/><text x="50%" y="52%" font-size="${Math.round(h / 6)}" fill="#fff" text-anchor="middle" font-family="sans-serif">${assetId} ${w}x${h}</text></svg>`;
  return { assetId, src: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, width: w, height: h };
}

const P = (id: string, c: string) => svgImage(id, 1000, 1500, c); // portrait 2:3
const L = (id: string, c: string) => svgImage(id, 1600, 1067, c); // landscape 3:2
const S = (id: string, c: string) => svgImage(id, 1200, 1200, c); // square

const pool = [
  L('hero', '#4a6741'),
  L('l1', '#8a5a44'), L('l2', '#44608a'), L('l3', '#7a4a6b'), L('l4', '#a08030'),
  P('p1', '#356060'), P('p2', '#603535'), P('p3', '#4a4a70'), P('p4', '#307050'), P('p5', '#705030'), P('p6', '#505050'),
  S('s1', '#906020'), S('s2', '#206090'),
];
const images = new Map(pool.map((i) => [i.assetId, i]));

const plan: PhotoBookPlan = {
  kind: 'photo',
  style: 'classic',
  cover: { heroAssetId: 'hero', title: 'Familie Muster', subtitle: 'Ein Jahr zusammen' },
  sections: [
    {
      title: 'Sommer am See',
      dateLabel: 'Juni 2025',
      pages: [
        { template: 'full-bleed', assetIds: ['l1'], captions: ['Der erste Abend am See'] },
        { template: 'full-framed', assetIds: ['p1'] },
        { template: 'two-vertical', assetIds: ['p2', 'p3'] },
        { template: 'two-horizontal', assetIds: ['l2', 'l3'] },
        { template: 'three-mixed', assetIds: ['l4', 'p4', 'p5'] },
        { template: 'three-column', assetIds: ['p6', 's1', 's2'] },
      ],
    },
  ],
};

const html = renderPhotoBookHtml({
  variant: 'print',
  chronicleName: 'Familie Muster',
  trim: { w: 210, h: 280 },
  plan,
  images,
  fontFaceCss: screenFontFaceCss('classic'),
  createdLabel: 'Juli 2026',
});

const out = process.argv[2] ?? '/tmp/photo-book-sample.html';
writeFileSync(out, html);
console.log(`wrote ${out}`);
