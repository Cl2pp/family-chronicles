import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `lib/gelato.ts` reads `env` at call time (not module scope), so each test can just
 * mutate the mocked module's fields directly — no need to re-import between cases. This
 * mirrors the "vi.mock a leaf dependency" pattern `lib/photo-hash.test.ts` uses for
 * `heic-decode`; `@/lib/env` is a bigger module (it validates the whole process.env at
 * import time), so mocking it here keeps this test from needing a real DATABASE_URL/
 * S3/OpenRouter/etc. environment just to price a book.
 */
const mockEnv = vi.hoisted(() => ({
  env: {
    GELATO_API_KEY: undefined as string | undefined,
    GELATO_PRODUCT_UID_21X28: 'hardcover-21x28-uid',
    GELATO_PRODUCT_UID_20X20: 'hardcover-20x20-uid',
    GELATO_PRODUCT_UID_SOFT_21X28: undefined as string | undefined,
    GELATO_PRODUCT_UID_SOFT_20X20: undefined as string | undefined,
    BOOK_MARGIN_EUR: 15,
  },
}));
vi.mock('@/lib/env', () => mockEnv);

afterEach(() => {
  mockEnv.env.GELATO_API_KEY = undefined;
  mockEnv.env.GELATO_PRODUCT_UID_SOFT_21X28 = undefined;
  mockEnv.env.GELATO_PRODUCT_UID_SOFT_20X20 = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('productUidForFormat', () => {
  it('resolves the hardcover UID for each size (always configured)', async () => {
    const { productUidForFormat } = await import('./gelato');
    expect(productUidForFormat('hardcover-21x28', 'hardcover')).toBe('hardcover-21x28-uid');
    expect(productUidForFormat('hardcover-20x20', 'hardcover')).toBe('hardcover-20x20-uid');
  });

  it('resolves the softcover UID for each size when configured', async () => {
    mockEnv.env.GELATO_PRODUCT_UID_SOFT_21X28 = 'soft-21x28-uid';
    mockEnv.env.GELATO_PRODUCT_UID_SOFT_20X20 = 'soft-20x20-uid';
    const { productUidForFormat } = await import('./gelato');
    expect(productUidForFormat('hardcover-21x28', 'softcover')).toBe('soft-21x28-uid');
    expect(productUidForFormat('hardcover-20x20', 'softcover')).toBe('soft-20x20-uid');
  });

  it('returns null for a softcover size with no configured UID (graceful fallback)', async () => {
    const { productUidForFormat } = await import('./gelato');
    expect(productUidForFormat('hardcover-21x28', 'softcover')).toBeNull();
    expect(productUidForFormat('hardcover-20x20', 'softcover')).toBeNull();
  });

  it('one softcover size can be configured while the other is not', async () => {
    mockEnv.env.GELATO_PRODUCT_UID_SOFT_21X28 = 'soft-21x28-uid';
    const { productUidForFormat } = await import('./gelato');
    expect(productUidForFormat('hardcover-21x28', 'softcover')).toBe('soft-21x28-uid');
    expect(productUidForFormat('hardcover-20x20', 'softcover')).toBeNull();
  });
});

describe('quoteBookPrice', () => {
  it('degrades to "price on request" when no Gelato key is configured', async () => {
    const { quoteBookPrice } = await import('./gelato');
    const quote = await quoteBookPrice({ format: 'hardcover-21x28', coverType: 'hardcover', pageCount: 40 });
    expect(quote.priced).toBe(false);
    expect(quote.total).toBeNull();
    expect(quote.productUid).toBe('hardcover-21x28-uid');
  });

  it('degrades to "price on request" for softcover when its UID is not configured, even with a Gelato key', async () => {
    mockEnv.env.GELATO_API_KEY = 'test-key';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { quoteBookPrice } = await import('./gelato');
    const quote = await quoteBookPrice({ format: 'hardcover-21x28', coverType: 'softcover', pageCount: 40 });
    expect(quote.priced).toBe(false);
    expect(quote.productUid).toBeNull();
    // Never even calls out to Gelato for a product that doesn't exist.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('prices a configured hardcover product via the Gelato quote endpoint', async () => {
    mockEnv.env.GELATO_API_KEY = 'test-key';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        quotes: [
          {
            products: [{ price: 12.5 }],
            shipmentMethods: [{ price: 4.5 }, { price: 9.9 }],
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { quoteBookPrice } = await import('./gelato');
    const quote = await quoteBookPrice({ format: 'hardcover-21x28', coverType: 'hardcover', pageCount: 40 });
    expect(quote.priced).toBe(true);
    expect(quote.productCost).toBe(12.5);
    expect(quote.shippingCost).toBe(4.5); // cheapest of the two shipment methods
    expect(quote.total).toBe(12.5 + 4.5 + 15);
  });

  it('prices a configured softcover product when its UID is set', async () => {
    mockEnv.env.GELATO_API_KEY = 'test-key';
    mockEnv.env.GELATO_PRODUCT_UID_SOFT_21X28 = 'soft-21x28-uid';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        quotes: [{ products: [{ price: 9 }], shipmentMethods: [{ price: 3 }] }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { quoteBookPrice } = await import('./gelato');
    const quote = await quoteBookPrice({ format: 'hardcover-21x28', coverType: 'softcover', pageCount: 40 });
    expect(quote.priced).toBe(true);
    expect(quote.productUid).toBe('soft-21x28-uid');
    expect(quote.total).toBe(9 + 3 + 15);
  });

  it('clamps pageCount into the Gelato-accepted 30-200 range', async () => {
    const { quoteBookPrice, MIN_PAGES, MAX_PAGES } = await import('./gelato');
    const low = await quoteBookPrice({ format: 'hardcover-21x28', coverType: 'hardcover', pageCount: 1 });
    const high = await quoteBookPrice({ format: 'hardcover-21x28', coverType: 'hardcover', pageCount: 5000 });
    expect(low.pageCount).toBe(MIN_PAGES);
    expect(high.pageCount).toBe(MAX_PAGES);
  });
});

describe('formatSummaryLabel', () => {
  it('reflects size and binding', async () => {
    const { formatSummaryLabel } = await import('./gelato');
    expect(formatSummaryLabel('hardcover-21x28', 'hardcover')).toBe('Hardcover 21 × 28 cm');
    expect(formatSummaryLabel('hardcover-20x20', 'hardcover')).toBe('Hardcover 20 × 20 cm');
    expect(formatSummaryLabel('hardcover-21x28', 'softcover')).toBe('Softcover 21 × 28 cm');
    expect(formatSummaryLabel('hardcover-20x20', 'softcover')).toBe('Softcover 20 × 20 cm');
  });
});
