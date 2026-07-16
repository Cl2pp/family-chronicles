/**
 * Generates the social / search preview image (1200×630) from the brand.
 * Run:  node scripts/generate-og-image.mjs
 * Outputs app/opengraph-image.png and app/twitter-image.png (Next's file
 * convention auto-emits og:image / twitter:image from these).
 */
import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FONT = "'Space Grotesk','Helvetica Neue',Helvetica,Arial,sans-serif";
const BODY = "'Outfit','Helvetica Neue',Helvetica,Arial,sans-serif";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#17211C"/>
  <circle cx="1080" cy="120" r="360" fill="#12C24A" opacity="0.10"/>

  <!-- wordmark -->
  <g transform="translate(64 60) scale(0.72)">
    <circle cx="18" cy="13" r="5.5" fill="#FFFFFF"/>
    <rect x="13" y="22" width="10" height="28" rx="5" fill="#FFFFFF"/>
    <circle cx="32" cy="19" r="5.5" fill="#FFFFFF" opacity="0.65"/>
    <rect x="27" y="28" width="10" height="22" rx="5" fill="#FFFFFF" opacity="0.65"/>
    <circle cx="46" cy="27" r="5.5" fill="#7BE84B"/>
    <rect x="41" y="36" width="10" height="14" rx="5" fill="#7BE84B"/>
  </g>
  <text x="118" y="98" font-family="${FONT}" font-size="34" font-weight="600" letter-spacing="-1" fill="#FFFFFF">Familienwerk</text>

  <!-- headline -->
  <text x="64" y="286" font-family="${FONT}" font-size="72" font-weight="700" letter-spacing="-2.5" fill="#FFFFFF">Eure Familie schreibt</text>
  <text x="64" y="372" font-family="${FONT}" font-size="72" font-weight="700" letter-spacing="-2.5" fill="#FFFFFF">ihr eigenes Buch.</text>

  <!-- subtitle -->
  <text x="66" y="440" font-family="${BODY}" font-size="27" font-weight="400" fill="#A9EE93">Privates Familienwerk aus Stimmen &amp; Erinnerungen.</text>

  <!-- book motif, bottom-right -->
  <g transform="translate(902 250)">
    <rect x="8" y="8" width="230" height="300" rx="10" fill="#0C8038" opacity="0.5"/>
    <rect width="230" height="300" rx="10" fill="#12C24A"/>
    <rect width="20" height="300" rx="8" fill="#0C8038"/>
    <g transform="translate(150 40) scale(1.1)">
      <circle cx="18" cy="13" r="5.5" fill="#FFFFFF"/>
      <rect x="13" y="22" width="10" height="28" rx="5" fill="#FFFFFF"/>
      <circle cx="32" cy="19" r="5.5" fill="#FFFFFF" opacity="0.7"/>
      <rect x="27" y="28" width="10" height="22" rx="5" fill="#FFFFFF" opacity="0.7"/>
      <circle cx="46" cy="27" r="5.5" fill="#0C8038"/>
      <rect x="41" y="36" width="10" height="14" rx="5" fill="#0C8038"/>
    </g>
    <text x="52" y="210" font-family="${FONT}" font-size="30" font-weight="600" letter-spacing="-1" fill="#FFFFFF">Familie</text>
    <text x="52" y="248" font-family="${FONT}" font-size="30" font-weight="600" letter-spacing="-1" fill="#FFFFFF">Müller</text>
  </g>

  <!-- footer -->
  <text x="64" y="566" font-family="${BODY}" font-size="22" font-weight="500" fill="#FFFFFF" opacity="0.55">familienwerk.co · Privat · Nur auf Einladung · DE / EN</text>
</svg>`;

const png = await sharp(Buffer.from(svg)).png().toBuffer();
await writeFile(path.join(ROOT, 'app', 'opengraph-image.png'), png);
await writeFile(path.join(ROOT, 'app', 'twitter-image.png'), png);
console.log('og + twitter image written');
