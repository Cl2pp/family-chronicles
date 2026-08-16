import { env } from '@/lib/env';

/**
 * Gelato print-on-demand integration — the raw HTTP client, nothing else.
 *
 * Four endpoints: the order quote (`quoteBookPrice`, prices a book), cover dimensions
 * (`getGelatoCoverDimensions`, sizes the wraparound cover spread the print file needs —
 * `lib/book-print-file.ts`), order creation (`createGelatoOrder`) and order lookup
 * (`getGelatoOrder`, status + tracking). The order lifecycle around them (who may order,
 * pinning the print file, the worker job, status mapping into `book_orders`) lives in
 * `lib/book-orders.ts`; this module never touches the database.
 *
 * Docs: https://dashboard.gelato.com/docs/ (X-API-KEY auth). API access is included
 * in Gelato's free plan; the key lives in GELATO_API_KEY. Gelato bills the account
 * that owns the key — there is no payment step on our side.
 */

const QUOTE_URL = 'https://order.gelatoapis.com/v4/orders:quote';
const ORDERS_URL = 'https://order.gelatoapis.com/v4/orders';
const PRODUCT_URL = 'https://product.gelatoapis.com/v3/products';

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
 * A Gelato shipping recipient (their `ShippingAddressObject`, the fields we use). Field
 * limits per their docs: first/last name ≤25 chars, address lines ≤35, city ≤30,
 * postCode ≤15, country = ISO 3166-1 alpha-2, phone ≤25. `lib/book-orders.ts`'s
 * `bookShippingAddressSchema` enforces those before anything reaches this module.
 */
export interface GelatoRecipient {
  firstName: string;
  lastName: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  postCode: string;
  country: string;
  email: string;
  phone?: string;
}

/**
 * The quote call needs a recipient. Callers that already know the real shipping
 * address pass it (exact shipping cost); the order screen's price preview quotes
 * against this fixed German address and says so ("incl. shipping within Germany").
 */
export const QUOTE_RECIPIENT: GelatoRecipient = {
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
  /** Real recipient for an exact shipping price; defaults to `QUOTE_RECIPIENT`. */
  recipient?: GelatoRecipient;
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
        recipient: input.recipient ?? QUOTE_RECIPIENT,
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

/* ──────────────────────────────────────────────────────────────────────────
 * Cover dimensions — sizes the wraparound cover spread of the Gelato print file
 * ────────────────────────────────────────────────────────────────────────── */

/** One rectangle of Gelato's cover-dimensions response, in mm, measured from the
 *  spread's top-left. `thickness` only appears on the wraparound areas. */
export interface GelatoCoverArea {
  width: number;
  height: number;
  left: number;
  top: number;
  thickness?: number;
}

/**
 * Gelato's cover-dimensions response for a photo book at a given inner page count
 * (`GET /v3/products/{uid}/cover-dimensions?pageCount=N`), in mm. Hardcover books report
 * the wraparound areas + joints; softcover books report `bleedSize` instead (see the
 * per-product table in their docs). `spread` is the full page size of the cover PDF page:
 * `wraparoundInsideSize` for hardcover, `bleedSize` for softcover.
 */
export interface GelatoCoverDimensions {
  productUid: string;
  /** Gelato's echo of the inner page count it sized the cover for. */
  pagesCount: number;
  spread: GelatoCoverArea;
  wraparoundInsideSize?: GelatoCoverArea;
  wraparoundEdgeSize?: GelatoCoverArea;
  bleedSize?: GelatoCoverArea;
  contentBackSize: GelatoCoverArea;
  jointBackSize?: GelatoCoverArea;
  spineSize: GelatoCoverArea;
  jointFrontSize?: GelatoCoverArea;
  contentFrontSize: GelatoCoverArea;
}

class GelatoError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GelatoError';
  }
}
export { GelatoError };

function requireApiKey(): string {
  if (!env.GELATO_API_KEY) throw new GelatoError('GELATO_API_KEY is not configured');
  return env.GELATO_API_KEY;
}

async function gelatoFetch<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const { timeoutMs = 20_000, ...rest } = init;
  const res = await fetch(url, {
    ...rest,
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': requireApiKey(), ...(rest.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 1000);
    throw new GelatoError(`Gelato ${rest.method ?? 'GET'} ${url} failed: HTTP ${res.status} ${body}`, res.status);
  }
  return (await res.json()) as T;
}

/** Throws (GelatoError) on any failure — the caller (the render job) decides whether a
 *  missing cover spread is fatal or just means "no Gelato file this render". */
export async function getGelatoCoverDimensions(productUid: string, pageCount: number): Promise<GelatoCoverDimensions> {
  type Raw = Omit<GelatoCoverDimensions, 'spread'> & { measureUnit?: string };
  const url = `${PRODUCT_URL}/${encodeURIComponent(productUid)}/cover-dimensions?pageCount=${pageCount}`;
  const raw = await gelatoFetch<Raw>(url);
  const spread = raw.wraparoundInsideSize ?? raw.bleedSize;
  if (!spread || !raw.contentBackSize || !raw.spineSize || !raw.contentFrontSize) {
    throw new GelatoError(`Gelato cover-dimensions response missing areas: ${JSON.stringify(raw).slice(0, 500)}`);
  }
  if (raw.measureUnit && raw.measureUnit !== 'mm') {
    throw new GelatoError(`Gelato cover-dimensions in unexpected unit "${raw.measureUnit}"`);
  }
  return { ...raw, spread };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Orders — create + read back
 * ────────────────────────────────────────────────────────────────────────── */

/** Gelato's order `fulfillmentStatus` values we map (their "How orders work" page). */
export type GelatoFulfillmentStatus =
  | 'created'
  | 'uploading'
  | 'passed'
  | 'in_production'
  | 'printed'
  | 'draft'
  | 'failed'
  | 'canceled'
  | 'pending_approval'
  | 'on_hold'
  | 'shipped'
  | 'in_transit'
  | 'delivered'
  | 'returned'
  | (string & {});

export interface GelatoOrder {
  id: string;
  orderReferenceId: string;
  orderType: 'order' | 'draft';
  fulfillmentStatus: GelatoFulfillmentStatus;
  financialStatus?: string;
  /** First package's tracking, when Gelato has handed the parcel to a carrier. */
  trackingCode: string | null;
  trackingUrl: string | null;
  /** Everything Gelato returned, for logging/debugging. */
  raw: unknown;
}

interface GelatoOrderResponse {
  id: string;
  orderReferenceId: string;
  orderType: 'order' | 'draft';
  fulfillmentStatus: string;
  financialStatus?: string;
  shipment?: { packages?: Array<{ trackingCode?: string | null; trackingUrl?: string | null }> } | null;
}

function toGelatoOrder(raw: GelatoOrderResponse): GelatoOrder {
  const pkg = raw.shipment?.packages?.find((p) => p.trackingCode || p.trackingUrl);
  return {
    id: raw.id,
    orderReferenceId: raw.orderReferenceId,
    orderType: raw.orderType,
    fulfillmentStatus: raw.fulfillmentStatus,
    financialStatus: raw.financialStatus,
    trackingCode: pkg?.trackingCode ?? null,
    trackingUrl: pkg?.trackingUrl ?? null,
    raw,
  };
}

/**
 * Create a Gelato order for one photo book (`POST /v4/orders`). `fileUrl` must be a
 * publicly fetchable URL (a presigned S3 GET) of the Gelato-format PDF (cover spread +
 * endpapers + inner pages, `lib/book-print-file.ts`); `pageCount` is the INNER page
 * count that PDF was built for. `orderType` defaults to `env.GELATO_ORDER_TYPE`
 * (`draft` unless production explicitly says `order`). Throws GelatoError on failure —
 * NOT idempotent on Gelato's side, so callers must guard against double submission
 * (`orderReferenceId` is echoed back but doesn't dedupe).
 */
export async function createGelatoOrder(input: {
  orderReferenceId: string;
  customerReferenceId: string;
  productUid: string;
  pageCount: number;
  fileUrl: string;
  recipient: GelatoRecipient;
  currency?: string;
  orderType?: 'order' | 'draft';
}): Promise<GelatoOrder> {
  const raw = await gelatoFetch<GelatoOrderResponse>(ORDERS_URL, {
    method: 'POST',
    timeoutMs: 60_000,
    body: JSON.stringify({
      // `?? 'draft'` is not dead code: lib/env.ts's SKIP_ENV_VALIDATION escape hatch
      // returns raw process.env, where an unset GELATO_ORDER_TYPE has no default — and
      // "unset" must never mean "print it for real".
      orderType: input.orderType ?? env.GELATO_ORDER_TYPE ?? 'draft',
      orderReferenceId: input.orderReferenceId,
      customerReferenceId: input.customerReferenceId,
      currency: input.currency ?? 'EUR',
      items: [
        {
          itemReferenceId: 'book-1',
          productUid: input.productUid,
          pageCount: input.pageCount,
          quantity: 1,
          files: [{ type: 'default', url: input.fileUrl }],
        },
      ],
      shippingAddress: input.recipient,
    }),
  });
  return toGelatoOrder(raw);
}

/** `GET /v4/orders/{id}` — current status + tracking. Throws GelatoError on failure.
 *  `timeoutMs` defaults to the client's usual 20s; callers on a request path (the order
 *  page's lazy poll) pass something much shorter so a slow Gelato can't hold up a render. */
export async function getGelatoOrder(
  gelatoOrderId: string,
  opts: { timeoutMs?: number } = {},
): Promise<GelatoOrder> {
  const raw = await gelatoFetch<GelatoOrderResponse>(`${ORDERS_URL}/${encodeURIComponent(gelatoOrderId)}`, {
    timeoutMs: opts.timeoutMs,
  });
  return toGelatoOrder(raw);
}

/** Our `book_orders.status` vocabulary (see the table's doc comment in db/schema.ts). */
export type BookOrderStatus =
  | 'submitting'
  | 'submitted'
  | 'in_production'
  | 'shipped'
  | 'delivered'
  | 'failed'
  | 'cancelled';

/**
 * Map Gelato's `fulfillmentStatus` onto ours. Anything not listed (uploading, passed,
 * pending_approval, on_hold, draft, …) stays `submitted` — accepted, not yet in
 * production — and the raw value is kept in `book_orders.gelato_status` for the admin.
 */
export function mapGelatoStatus(status: GelatoFulfillmentStatus): BookOrderStatus {
  switch (status) {
    case 'in_production':
    case 'printed':
      return 'in_production';
    case 'shipped':
    case 'in_transit':
      return 'shipped';
    case 'delivered':
      return 'delivered';
    // Gelato documents the American spelling; accept both so a change of spelling on
    // their side can't silently turn a cancellation back into "accepted".
    case 'canceled':
    case 'cancelled':
    case 'returned':
      return 'cancelled';
    case 'failed':
      return 'failed';
    default:
      return 'submitted';
  }
}
