/**
 * Regenerates the PWA raster icons + favicon from the Familienwerk voice-bars
 * mark. Run after changing the mark:  `node scripts/generate-icons.mjs`
 *
 * Outputs (public/): icon-192.png, icon-512.png, icon-maskable-512.png,
 * apple-touch-icon.png; and app/favicon.ico. The vector source of the mark is
 * public/icon.svg — keep the shapes below in sync with it.
 */
import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');

// The mark authored in a 64×64 box; `markScale`/`corner` place it in a 128 tile.
// corner: 32 → rounded app tile (25% radius); 0 → full-bleed square (maskable).
function tileSvg({ markScale = 1, corner = 32 } = {}) {
  const inner = 64 * markScale;
  const off = (128 - inner) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="${corner}" fill="#12C24A"/>
  <g transform="translate(${off} ${off}) scale(${markScale})">
    <circle cx="18" cy="13" r="5.5" fill="#FFFFFF"/>
    <rect x="13" y="22" width="10" height="28" rx="5" fill="#FFFFFF"/>
    <circle cx="32" cy="19" r="5.5" fill="#FFFFFF" opacity="0.6"/>
    <rect x="27" y="28" width="10" height="22" rx="5" fill="#FFFFFF" opacity="0.6"/>
    <circle cx="46" cy="27" r="5.5" fill="#0C8038"/>
    <rect x="41" y="36" width="10" height="14" rx="5" fill="#0C8038"/>
  </g>
</svg>`;
}

// Standard "any" icon matches public/icon.svg (rounded tile, full-size mark).
const anyTile = tileSvg({ markScale: 1 });
// Maskable: square + full-bleed to the corners, mark shrunk into the safe zone.
const maskTile = tileSvg({ markScale: 0.72, corner: 0 });

const png = (svg, size) => sharp(Buffer.from(svg)).resize(size, size).png().toBuffer();

async function main() {
  await writeFile(path.join(PUB, 'icon-192.png'), await png(anyTile, 192));
  await writeFile(path.join(PUB, 'icon-512.png'), await png(anyTile, 512));
  await writeFile(path.join(PUB, 'icon-maskable-512.png'), await png(maskTile, 512));
  await writeFile(path.join(PUB, 'apple-touch-icon.png'), await png(anyTile, 180));

  // favicon.ico — embed PNGs for 16/32/48 in a minimal ICO container.
  const sizes = [16, 32, 48];
  const imgs = await Promise.all(sizes.map((s) => png(anyTile, s)));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(sizes.length, 4);
  const dir = Buffer.alloc(16 * sizes.length);
  let offset = 6 + dir.length;
  imgs.forEach((buf, i) => {
    const b = i * 16;
    dir.writeUInt8(sizes[i], b + 0);
    dir.writeUInt8(sizes[i], b + 1);
    dir.writeUInt16LE(1, b + 4); // color planes
    dir.writeUInt16LE(32, b + 6); // bits per pixel
    dir.writeUInt32LE(buf.length, b + 8);
    dir.writeUInt32LE(offset, b + 12);
    offset += buf.length;
  });
  await writeFile(path.join(ROOT, 'app', 'favicon.ico'), Buffer.concat([header, dir, ...imgs]));

  console.log('icons written to', PUB);
}

main();
