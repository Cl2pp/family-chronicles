import { env } from '@/lib/env';

/**
 * Gelato print-on-demand integration.
 *
 * v1 uses exactly ONE endpoint — the order quote — to price a book. Actual order
 * submission (POST /v4/orders with the print PDF) is deliberately not implemented
 * yet: orders end at the "order at price" screen and are handled personally.
 *
 * Docs: https://dashboard.gelato.com/docs/ (X-API-KEY auth). API access is included
 * in Gelato's free plan; the key lives in GELATO_API_KEY.
 */

const QUOTE_URL = 'https://order.gelatoapis.com/v4/orders:quote';

export type BookFormat = 'hardcover-21x28' | 'hardcover-20x20';

export function productUidForFormat(format: BookFormat): string {
  return format === 'hardcover-20x20'
    ? env.GELATO_PRODUCT_UID_20X20
    : env.GELATO_PRODUCT_UID_21X28;
}

/** Human labels for the formats (locale-independent; sizes read the same in en/de). */
export const FORMAT_LABELS: Record<BookFormat, string> = {
  'hardcover-21x28': 'Hardcover 21 × 28 cm',
  'hardcover-20x20': 'Hardcover 20 × 20 cm',
};

/** Gelato photo books accept 30–200 inner pages. */
export const MIN_PAGES = 30;
export const MAX_PAGES = 200;

/** Snapshot stored on a book order and shown on the order screen. */
export interface BookQuote {
  /** Whether a live Gelato price backs this quote; false = "price on request". */
  priced: boolean;
  currency: string;
  productUid: string;
  pageCount: number;
  /** Gelato product cost (excl. VAT), when priced. */
  productCost: number | null;
  /** Cheapest shipping to Germany, when priced. */
  shippingCost: number | null;
  /** Flat margin from BOOK_MARGIN_EUR. */
  margin: number;
  /** productCost + shippingCost + margin, when priced. */
  total: number | null;
  quotedAt: string;
}

/**
 * The quote call needs a recipient; until real shipping-address collection exists
 * we quote against a fixed German address and say so in the UI ("incl. shipping
 * within Germany").
 */
const QUOTE_RECIPIENT = {
  country: 'DE',
  addressLine1: 'Musterstrasse 1',
  city: 'Berlin',
  postCode: '10115',
  firstName: 'Family',
  lastName: 'Chronicle',
  email: 'quote@familienwerk.co',
};

interface GelatoQuoteResponse {
  quotes?: Array<{
    products?: Array<{ price?: number; currency?: string }>;
    shipmentMethods?: Array<{ price?: number; currency?: string }>;
  }>;
}

/**
 * Price a book via Gelato's order-quote endpoint. Never throws: any failure
 * (missing key, network, unexpected shape) degrades to `priced: false` so the
 * user can still order and the admin prices it manually.
 */
export async function quoteBookPrice(input: {
  format: BookFormat;
  pageCount: number;
}): Promise<BookQuote> {
  const productUid = productUidForFormat(input.format);
  const pageCount = Math.min(MAX_PAGES, Math.max(MIN_PAGES, input.pageCount));
  const base: BookQuote = {
    priced: false,
    currency: 'EUR',
    productUid,
    pageCount,
    productCost: null,
    shippingCost: null,
    margin: env.BOOK_MARGIN_EUR,
    total: null,
    quotedAt: new Date().toISOString(),
  };
  if (!env.GELATO_API_KEY) return base;

  try {
    const res = await fetch(QUOTE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': env.GELATO_API_KEY },
      body: JSON.stringify({
        orderReferenceId: `quote-${Date.now()}`,
        customerReferenceId: 'family-chronicle',
        currency: 'EUR',
        allowMultipleQuotes: false,
        recipient: QUOTE_RECIPIENT,
        products: [
          {
            itemReferenceId: 'book-1',
            productUid,
            quantity: 1,
            pageCount,
          },
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.error(`[gelato] quote failed: HTTP ${res.status} ${await res.text()}`);
      return base;
    }
    const data = (await res.json()) as GelatoQuoteResponse;
    const quote = data.quotes?.[0];
    const productCost = quote?.products?.reduce((sum, p) => sum + (p.price ?? 0), 0) ?? null;
    const shippingCost =
      quote?.shipmentMethods
        ?.map((m) => m.price)
        .filter((p): p is number => typeof p === 'number')
        .sort((a, b) => a - b)[0] ?? null;
    if (productCost == null || shippingCost == null) {
      console.error('[gelato] quote response missing prices', JSON.stringify(data).slice(0, 500));
      return base;
    }
    const round = (n: number) => Math.round(n * 100) / 100;
    return {
      ...base,
      priced: true,
      productCost: round(productCost),
      shippingCost: round(shippingCost),
      total: round(productCost + shippingCost + env.BOOK_MARGIN_EUR),
    };
  } catch (err) {
    console.error('[gelato] quote failed:', err);
    return base;
  }
}
