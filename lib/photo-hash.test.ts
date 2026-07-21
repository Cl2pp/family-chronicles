import sharp, { type Sharp } from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { computeBlurScore, computeDHash, decodeForAnalysis, hammingDistance } from './photo-hash';

// heic-decode wraps a WASM HEIF decoder — too heavy/slow to exercise with a real
// file in a unit test, and no small HEIC fixture ships with the repo or the
// package. Mocking it lets us prove `decodeForAnalysis` routes HEIC/HEIF mime types
// through it (and only those) while feeding computeDHash/computeBlurScore a
// synthetic-but-real raw-pixel buffer, exercising the actual downstream pipeline.
vi.mock('heic-decode', () => ({ default: vi.fn() }));

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

/** Raw RGBA checkerboard pixels — stands in for what `heic-decode` would hand back
 *  (it returns decoded raw RGBA data, not an encoded container). */
function checkerboardRawRgba(size = 16, cell = 2): Buffer {
  const channels = 4;
  const data = Buffer.alloc(size * size * channels);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const isLight = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0;
      const value = isLight ? 255 : 0;
      const idx = (y * size + x) * channels;
      data[idx] = value;
      data[idx + 1] = value;
      data[idx + 2] = value;
      data[idx + 3] = 255;
    }
  }
  return data;
}

async function decodedPng(size = 64, cell = 4): Promise<Sharp> {
  return decodeForAnalysis(await checkerboardPng(size, cell), 'image/png');
}

describe('computeDHash', () => {
  it('is deterministic for the same image', async () => {
    const [imgA, imgB] = await Promise.all([decodedPng(), decodedPng()]);
    const [a, b] = await Promise.all([computeDHash(imgA), computeDHash(imgB)]);
    expect(a).toBe(b);
  });

  it('produces a 16-hex-digit (64-bit) hash', async () => {
    const hash = await computeDHash(await decodedPng());
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('differs for visibly different images', async () => {
    const a = await decodeForAnalysis(await checkerboardPng(64, 4, 0), 'image/png');
    const b = await decodeForAnalysis(await checkerboardPng(64, 16, 2), 'image/png');
    const [hashA, hashB] = await Promise.all([computeDHash(a), computeDHash(b)]);
    expect(hashA).not.toBe(hashB);
    expect(hammingDistance(hashA, hashB)).toBeGreaterThan(0);
  });

  it('gives a flat/uniform image the all-zero hash', async () => {
    const img = await decodeForAnalysis(await solidPng(), 'image/png');
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
    const sharpBuf = await checkerboardPng(128, 4);
    const blurredBuf = await sharp(sharpBuf).blur(12).png().toBuffer();

    const [sharpScore, blurredScore] = await Promise.all([
      computeBlurScore(await decodeForAnalysis(sharpBuf, 'image/png')),
      computeBlurScore(await decodeForAnalysis(blurredBuf, 'image/png')),
    ]);

    expect(sharpScore).toBeGreaterThan(blurredScore);
  });

  it('scores a flat image at (near) zero', async () => {
    const img = await decodeForAnalysis(await solidPng(), 'image/png');
    const score = await computeBlurScore(img);
    expect(score).toBeCloseTo(0, 5);
  });
});

describe('decodeForAnalysis (HEIC/HEIF routing)', () => {
  it('does not invoke the HEIC decoder for a regular format (PNG)', async () => {
    const heicDecode = (await import('heic-decode')).default as ReturnType<typeof vi.fn>;
    heicDecode.mockClear();
    await decodeForAnalysis(await checkerboardPng(), 'image/png');
    expect(heicDecode).not.toHaveBeenCalled();
  });

  it('routes image/heic through the heic-decode WASM decoder', async () => {
    const heicDecode = (await import('heic-decode')).default as ReturnType<typeof vi.fn>;
    heicDecode.mockClear();
    const raw = checkerboardRawRgba();
    heicDecode.mockResolvedValueOnce({ width: 16, height: 16, data: raw });

    // The bytes don't need to be a real HEIC container — the decoder is mocked —
    // but they do need to reach it verbatim, proving the routing (not the codec).
    const fakeHeicBytes = Buffer.from('not a real heic container');
    const image = await decodeForAnalysis(fakeHeicBytes, 'image/heic');

    expect(heicDecode).toHaveBeenCalledTimes(1);
    expect(heicDecode).toHaveBeenCalledWith({ buffer: fakeHeicBytes });
    // The decoded pipeline behaves like any other for downstream analysis.
    const hash = await computeDHash(image);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('routes image/heif and parameterized HEIC mime types through the same decoder', async () => {
    const heicDecode = (await import('heic-decode')).default as ReturnType<typeof vi.fn>;
    const raw = checkerboardRawRgba();
    heicDecode.mockClear();
    heicDecode.mockResolvedValue({ width: 16, height: 16, data: raw });

    await decodeForAnalysis(Buffer.from('heif'), 'image/heif');
    await decodeForAnalysis(Buffer.from('heic-with-params'), 'image/heic;charset=binary');

    expect(heicDecode).toHaveBeenCalledTimes(2);
  });

  it('a single decoded image can feed both computeDHash and computeBlurScore, matching analyzePhotoMeta\'s Promise.all usage', async () => {
    const image = await decodedPng(128, 4);
    const [hash, blur] = await Promise.all([computeDHash(image), computeBlurScore(image)]);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(blur).toBeGreaterThanOrEqual(0);
  });
});
