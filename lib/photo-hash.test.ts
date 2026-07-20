import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { computeBlurScore, computeDHash, hammingDistance } from './photo-hash';

/** A synthetic high-frequency test image — cheaper and more deterministic than a
 *  real photo fixture, and gives predictable sharp/blur behavior under a Gaussian
 *  blur. `phase` shifts the pattern so two calls produce visibly different images. */
async function checkerboardPng(size = 64, cell = 4, phase = 0): Promise<Buffer> {
  const channels = 3;
  const data = Buffer.alloc(size * size * channels);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const isLight = (Math.floor((x + phase) / cell) + Math.floor(y / cell)) % 2 === 0;
      const value = isLight ? 255 : 0;
      const idx = (y * size + x) * channels;
      data[idx] = value;
      data[idx + 1] = value;
      data[idx + 2] = value;
    }
  }
  return sharp(data, { raw: { width: size, height: size, channels } }).png().toBuffer();
}

async function solidPng(size = 64, value = 128): Promise<Buffer> {
  const channels = 3;
  const data = Buffer.alloc(size * size * channels, value);
  return sharp(data, { raw: { width: size, height: size, channels } }).png().toBuffer();
}

describe('computeDHash', () => {
  it('is deterministic for the same image', async () => {
    const img = await checkerboardPng();
    const [a, b] = await Promise.all([computeDHash(img), computeDHash(img)]);
    expect(a).toBe(b);
  });

  it('produces a 16-hex-digit (64-bit) hash', async () => {
    const img = await checkerboardPng();
    const hash = await computeDHash(img);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('differs for visibly different images', async () => {
    const a = await checkerboardPng(64, 4, 0);
    const b = await checkerboardPng(64, 16, 2);
    const [hashA, hashB] = await Promise.all([computeDHash(a), computeDHash(b)]);
    expect(hashA).not.toBe(hashB);
    expect(hammingDistance(hashA, hashB)).toBeGreaterThan(0);
  });

  it('gives a flat/uniform image the all-zero hash', async () => {
    const img = await solidPng();
    const hash = await computeDHash(img);
    expect(hash).toBe('0'.repeat(16));
  });
});

describe('hammingDistance', () => {
  it('is zero for identical hashes', () => {
    expect(hammingDistance('abcdef0123456789', 'abcdef0123456789')).toBe(0);
  });

  it('counts differing bits', () => {
    // '0' vs 'f' differ in all 4 bits of that hex digit; the rest match.
    expect(hammingDistance('0000000000000000', 'f000000000000000')).toBe(4);
  });

  it('rejects hashes of different lengths', () => {
    expect(() => hammingDistance('ab', 'abcd')).toThrow();
  });
});

describe('computeBlurScore', () => {
  it('scores a sharp high-frequency image higher than its blurred version', async () => {
    const sharpImg = await checkerboardPng(128, 4);
    const blurredImg = await sharp(sharpImg).blur(12).png().toBuffer();

    const [sharpScore, blurredScore] = await Promise.all([
      computeBlurScore(sharpImg),
      computeBlurScore(blurredImg),
    ]);

    expect(sharpScore).toBeGreaterThan(blurredScore);
  });

  it('scores a flat image at (near) zero', async () => {
    const img = await solidPng();
    const score = await computeBlurScore(img);
    expect(score).toBeCloseTo(0, 5);
  });
});
