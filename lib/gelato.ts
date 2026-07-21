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

/** NOTE: despite the "hardcover-" prefix, these values name the SIZE/trim only (21×28 vs
 *  20×20 cm) — see `bookFormat`'s comment in db/schema.ts. The hardcover-vs-softcover
 *  binding choice is the separate `BookCoverType` below; `productUidForFormat` combines
 *  both to pick the actual Gelato product. */
export type BookFormat = 'hardcover-21x28' | 'hardcover-20x20';

/** Hardcover vs softcover binding (`books.cover_type`, PR6's photo-book config panel). */
export type BookCoverType = 'hardcover' | 'softcover';

/**
 * Resolves the Gelato product UID for a (size, binding) combination. Hardcover UIDs are
 * always configured (env defaults, existing behavior). Softcover UIDs
 * (`GELATO_PRODUCT_UID_SOFT_21X28`/`_20X20`) are optional and have no default — Gelato
 * softcover photo-book products haven't been picked yet — so this returns `null` when the
 * relevant one isn't set, and `quoteBookPrice` below degrades to "price on request"
 * instead of quoting (or crashing on) a product that doesn't exist.
 */
export function productUidForFormat(format: BookFormat, coverType: BookCoverType): string | null {
  if (coverType === 'softcover') {
    return format === 'hardcover-20x20'
      ? (env.GELATO_PRODUCT_UID_SOFT_20X20 ?? null)
      : (env.GELATO_PRODUCT_UID_SOFT_21X28 ?? null);
  }
  return format === 'hardcover-20x20' ? env.GELATO_PRODUCT_UID_20X20 : env.GELATO_PRODUCT_UID_21X28;
}

/** Human labels for the formats (locale-independent; sizes read the same in en/de).
 *  Hardcover-only — kept for any caller that only ever deals in hardcover (today, that's
 *  every story book, which has no cover-type UI). Photo books, which DO expose a
 *  cover-type choice, use `formatSummaryLabel` below instead so the label reflects the
 *  binding the user actually picked. */
export const FORMAT_LABELS: Record<BookFormat, string> = {
  'hardcover-21x28': 'Hardcover 21 × 28 cm',
  'hardcover-20x20': 'Hardcover 20 × 20 cm',
};

/** Human label for a (size, binding) combination — the order screen's summary row for
 *  any book kind. Equivalent to `FORMAT_LABELS` when `coverType` is 'hardcover' (every
 *  story book); reflects 'Softcover' for a photo book configured that way. */
export function formatSummaryLabel(format: BookFormat, coverType: BookCoverType): string {
  const size = format === 'hardcover-20x20' ? '20 × 20 cm' : '21 × 28 cm';
  const binding = coverType === 'softcover' ? 'Softcover' : 'Hardcover';
  return `${binding} ${size}`;
}

/** Gelato photo books accept 30–200 inner pages. */
export const MIN_PAGES = 30;
export const MAX_PAGES = 200;

/** Snapshot stored on a book order and shown on the order screen. */
export interface BookQuote {
  /** Whether a live Gelato price backs this quote; false = "price on request". */
  priced: boolean;
  currency: string;
  /** Null when no Gelato product is configured for the requested (size, coverType)
   *  combination (currently: any softcover size, until GELATO_PRODUCT_UID_SOFT_* is set)
   *  — `priced` is always false in that case too. */
  productUid: string | null;
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
  coverType: BookCoverType;
  pageCount: number;
}): Promise<BookQuote> {
  const productUid = productUidForFormat(input.format, input.coverType);
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
  // No Gelato key, or no product configured for this (size, coverType) combination
  // (currently: softcover with its env UID unset) — "price on request" either way.
  if (!env.GELATO_API_KEY || !productUid) return base;

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
