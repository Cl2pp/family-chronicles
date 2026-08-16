import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, isNull, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db';
import { books, bookOrders } from '@/db/schema';
import { env } from '@/lib/env';
import { getBookForUser, type Result } from '@/lib/books';
import { isBookPrintFresh } from '@/lib/book-print-status';
import {
  createGelatoOrder,
  getGelatoOrder,
  mapGelatoStatus,
  quoteBookPrice,
  GelatoError,
  MAX_PAGES,
  QUOTE_RECIPIENT,
  type BookOrderStatus,
  type BookQuote,
  type GelatoRecipient,
} from '@/lib/gelato';
import { enqueueSubmitBookOrder } from '@/lib/queue';
import { sendEmail } from '@/lib/email';
import { deleteObject, getObjectBuffer, presignGet, putObjectBuffer } from '@/lib/s3';

/**
 * Book-order lifecycle — the ONE place `book_orders` rows are written. `lib/gelato.ts`
 * stays a pure HTTP client; everything stateful (who may order, pinning the print file,
 * the worker's submit job, mapping Gelato's status back onto ours) lives here.
 *
 * There is no in-app payment: Gelato bills the card on the account that owns
 * GELATO_API_KEY, so ordering is gated to a short allow-list of account emails
 * (`BOOK_ORDERING_ALLOWED_EMAILS`). Everyone else keeps the "email us" order flow.
 *
 * Flow: `placeBookOrder` (web) validates + quotes + pins the print file, writes the row
 * as `submitting`, locks the book (`books.status = 'ordered'`) and queues
 * `submit-book-order` → `submitBookOrder` (worker) claims the row with one conditional
 * UPDATE and POSTs it to Gelato exactly once → `syncBookOrderStatus` (lazily, from the
 * order page) keeps status + tracking fresh.
 *
 * The book's lock and the order are kept in step in both directions: every path that
 * ends in `failed` or `cancelled` also calls `releaseBook`, so a dead order never leaves
 * a book stuck at `ordered` (uneditable, undeletable, un-reorderable).
 */

const err = (error: string) => ({ ok: false as const, error });

/** Countries we ship to for now — every Gelato shipping country would need its own
 *  address-format handling, so this stays deliberately small. */
export const BOOK_SHIPPING_COUNTRIES = ['DE', 'AT', 'CH'] as const;

export type BookShippingCountry = (typeof BOOK_SHIPPING_COUNTRIES)[number];

/** Recipient as stored on the order and submitted to Gelato (`GelatoRecipient`). */
export interface BookShippingAddress {
  firstName: string;
  lastName: string;
  addressLine1: string;
  addressLine2?: string;
  postCode: string;
  city: string;
  /** ISO 3166-1 alpha-2, restricted to `BOOK_SHIPPING_COUNTRIES`. */
  country: string;
  email: string;
  phone?: string;
}

/** Field limits are Gelato's (see `GelatoRecipient` in lib/gelato.ts) — enforced here so
 *  a too-long name is a form error, not an opaque HTTP 400 from the order call. */
export const bookShippingAddressSchema = z.object({
  firstName: z.string().trim().min(1).max(25),
  lastName: z.string().trim().min(1).max(25),
  addressLine1: z.string().trim().min(1).max(35),
  addressLine2: z.string().trim().max(35).optional(),
  postCode: z.string().trim().min(1).max(15),
  city: z.string().trim().min(1).max(30),
  country: z.enum(BOOK_SHIPPING_COUNTRIES),
  email: z.string().trim().email().max(100),
  phone: z.string().trim().max(25).optional(),
});

/** Whether this account may order books in the app at all (`BOOK_ORDERING_ALLOWED_EMAILS`).
 *  Empty list = nobody. `lib/env.ts` normally hands this over already split + lowercased,
 *  but its `SKIP_ENV_VALIDATION` escape hatch returns the raw `process.env` string — so
 *  accept either shape rather than crashing on `.includes` of a string. */
export function canUserOrderBooks(email: string | null | undefined): boolean {
  if (!email) return false;
  const raw: unknown = env.BOOK_ORDERING_ALLOWED_EMAILS;
  const allowed = Array.isArray(raw)
    ? (raw as string[])
    : String(raw ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
  return allowed.includes(email.trim().toLowerCase());
}

/** One order as the order screen sees it. */
export interface BookOrderView {
  id: string;
  bookId: string;
  status: BookOrderStatus;
  /** What Gelato holds: a reviewable `draft` in the dashboard, or a real `order`.
   *  Null until Gelato has accepted the submission. */
  orderType: 'order' | 'draft' | null;
  gelatoOrderId: string | null;
  /** Gelato's own raw `fulfillmentStatus`, for the admin. */
  gelatoStatus: string | null;
  trackingCode: string | null;
  trackingUrl: string | null;
  shippingAddress: BookShippingAddress | null;
  quote: BookQuote;
  errorMessage: string | null;
  createdAt: string;
  submittedAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
}

/** How far along an order is — used to make status only ever move forward when Gelato is
 *  polled out of order (a late `created` must not undo a `shipped`). */
const STATUS_RANK: Record<BookOrderStatus, number> = {
  submitting: 0,
  submitted: 1,
  in_production: 2,
  shipped: 3,
  delivered: 4,
  failed: 5,
  cancelled: 5,
};

/** `failed`/`cancelled` are terminal verdicts and always win; otherwise only forward.
 *  Exported for its own unit test — it is the rule that keeps a slow Gelato poll from
 *  walking an order backwards. */
export function advanceStatus(current: BookOrderStatus, next: BookOrderStatus): BookOrderStatus {
  if (next === 'failed' || next === 'cancelled') return next;
  if (current === 'failed' || current === 'cancelled') return current;
  return STATUS_RANK[next] > STATUS_RANK[current] ? next : current;
}

/** Statuses worth asking Gelato about again. */
const POLLABLE: BookOrderStatus[] = ['submitted', 'in_production', 'shipped'];

/** The dead ends. A row in one of these no longer holds the book: it doesn't block a new
 *  order, doesn't block deletion, and isn't covered by `book_orders_open_uq`. */
const DEAD_STATUSES = ['failed', 'cancelled'] as const;

/** How stale a `statusCheckedAt` may be before the order page re-polls Gelato. */
const STATUS_POLL_MAX_AGE_MS = 2 * 60 * 1000;
/** See `getLatestBookOrder` — a `submitting` row older than this is declared dead. */
const SUBMITTING_TIMEOUT_MS = 10 * 60 * 1000;

type OrderRow = typeof bookOrders.$inferSelect;
/** `db` or a transaction handle — `releaseBook` runs in both. */
type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Give a book back to its owner. Placing an order locks the book at `status = 'ordered'`
 * (no edits, no deletion, no second order); when that order dies — the submission failed,
 * the queue rejected it, the worker never came back, or Gelato cancelled it — the lock
 * has to come off, or the book is stranded forever.
 *
 * Deliberately conditional on the book still being `ordered`, so it can never stomp on a
 * render that has since moved the book somewhere else.
 */
async function releaseBook(bookId: string, tx: Executor = db): Promise<void> {
  await tx
    .update(books)
    .set({ status: 'preview_ready', updatedAt: new Date() })
    .where(and(eq(books.id, bookId), eq(books.status, 'ordered')));
}

/** Postgres' unique-violation code, however drizzle/pg wraps the driver error. */
function isUniqueViolation(e: unknown): boolean {
  const direct = (e as { code?: unknown })?.code;
  const nested = (e as { cause?: { code?: unknown } })?.cause?.code;
  return direct === '23505' || nested === '23505';
}

function toView(row: OrderRow): BookOrderView {
  const gelatoStatus = row.gelatoStatus;
  return {
    id: row.id,
    bookId: row.bookId,
    status: row.status as BookOrderStatus,
    // Gelato's own answer when we have it; otherwise the old inference for rows written
    // before `gelato_order_type` existed.
    orderType:
      (row.gelatoOrderType as 'order' | 'draft' | null) ??
      (gelatoStatus === 'draft' ? 'draft' : row.gelatoOrderId ? 'order' : null),
    gelatoOrderId: row.gelatoOrderId,
    gelatoStatus,
    trackingCode: row.trackingCode,
    trackingUrl: row.trackingUrl,
    shippingAddress: (row.shippingAddress as BookShippingAddress | null) ?? null,
    quote: row.quote as BookQuote,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
    submittedAt: row.submittedAt?.toISOString() ?? null,
    shippedAt: row.shippedAt?.toISOString() ?? null,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
  };
}

async function latestOrderRow(bookId: string): Promise<OrderRow | null> {
  const [row] = await db
    .select()
    .from(bookOrders)
    .where(eq(bookOrders.bookId, bookId))
    .orderBy(desc(bookOrders.createdAt))
    .limit(1);
  return row ?? null;
}

/** The book's one order that is still alive (anything but `failed`/`cancelled`). The
 *  `book_orders_open_uq` index guarantees there is at most one. */
async function liveOrderRow(bookId: string): Promise<OrderRow | null> {
  const [row] = await db
    .select()
    .from(bookOrders)
    .where(and(eq(bookOrders.bookId, bookId), notInArray(bookOrders.status, [...DEAD_STATUSES])))
    .limit(1);
  return row ?? null;
}

/**
 * The book's most recent order, for a user who may read the book. Lazily refreshes the
 * status from Gelato when it's non-terminal and the last check is older than two
 * minutes — the order screen has no webhook, so a page view IS the poll. Gelato failures
 * never propagate: a dead order must not break the page.
 */
export async function getLatestBookOrder(bookId: string, userId: string): Promise<BookOrderView | null> {
  const book = await getBookForUser(bookId, userId);
  if (!book) return null;
  let row = await latestOrderRow(bookId);
  if (!row) return null;

  // A `submitting` row whose job died (worker crash, pg-boss expiry — the queue has
  // retryLimit 0 on purpose) would otherwise sit there forever with no way out: the
  // retry path only accepts `failed`. The job expires after 5 minutes and the Gelato
  // POST times out after 1, so nothing is still running SUBMITTING_TIMEOUT_MS after the
  // worker claimed it (`submitStartedAt`) — or, if it never got that far, after the row
  // was last written. Flip it to `failed`, unlock the book, and let the order page offer
  // "Try again". If the POST did go through and only the write-back was lost, the retry
  // creates a second Gelato order (visible in their dashboard; a draft when
  // GELATO_ORDER_TYPE=draft) — say so.
  const startedAt = row.submitStartedAt ?? row.updatedAt;
  if (row.status === 'submitting' && !row.gelatoOrderId && Date.now() - startedAt.getTime() > SUBMITTING_TIMEOUT_MS) {
    await failOrder(
      row.id,
      row.bookId,
      'The submission to Gelato did not finish in time. Check the Gelato dashboard for a matching order before trying again.',
      { onlyWhileSubmitting: true },
    );
    row = (await latestOrderRow(bookId)) ?? row;
  }

  const stale =
    !row.statusCheckedAt || Date.now() - row.statusCheckedAt.getTime() > STATUS_POLL_MAX_AGE_MS;
  if (row.gelatoOrderId && POLLABLE.includes(row.status as BookOrderStatus) && stale) {
    await syncBookOrderStatus(row.id);
    row = (await latestOrderRow(bookId)) ?? row;
  }
  return toView(row);
}

/** Mark an order dead and hand the book back, in one transaction so the two can't drift.
 *  The book is released only if the order really did move to `failed` — with
 *  `onlyWhileSubmitting` the update is a no-op when something else got there first (the
 *  worker's write-back landing just as the timeout fired), and unlocking a book whose
 *  order is alive and well would be worse than leaving the timeout unhandled. */
async function failOrder(
  orderId: string,
  bookId: string,
  message: string,
  opts: { onlyWhileSubmitting?: boolean } = {},
): Promise<void> {
  await db.transaction(async (tx) => {
    const failed = await tx
      .update(bookOrders)
      .set({ status: 'failed', errorMessage: message, updatedAt: new Date() })
      .where(
        opts.onlyWhileSubmitting
          ? and(eq(bookOrders.id, orderId), eq(bookOrders.status, 'submitting'))
          : eq(bookOrders.id, orderId),
      )
      .returning({ id: bookOrders.id });
    if (failed.length > 0) await releaseBook(bookId, tx);
  });
}

/* ──────────────────────────────────────────────────────────────────────────
 * Quoting a book for one of the countries we ship to
 * ────────────────────────────────────────────────────────────────────────── */

/** A stand-in delivery address per shipping country, so the order screen's price preview
 *  reflects the shipping cost to the country the user picked before they have typed an
 *  address. Same placeholder person as `QUOTE_RECIPIENT`; only the location changes. */
export function quoteRecipientForCountry(country: string): GelatoRecipient {
  switch (country) {
    case 'AT':
      return { ...QUOTE_RECIPIENT, country: 'AT', addressLine1: 'Musterstraße 1', city: 'Wien', postCode: '1010' };
    case 'CH':
      return { ...QUOTE_RECIPIENT, country: 'CH', addressLine1: 'Musterstrasse 1', city: 'Zürich', postCode: '8001' };
    default:
      return QUOTE_RECIPIENT;
  }
}

/**
 * Price a book for one shipping country, without an address — what the order screen shows
 * while the user is still choosing where the book should go. Never writes anything;
 * `placeBookOrder` re-quotes against the real address before the order is stored.
 */
export async function quoteBookForCountry(
  bookId: string,
  userId: string,
  country: string,
): Promise<Result<BookQuote>> {
  if (!(BOOK_SHIPPING_COUNTRIES as readonly string[]).includes(country)) {
    return err('We only ship to Germany, Austria and Switzerland at the moment.');
  }
  const book = await getBookForUser(bookId, userId);
  if (!book) return err('Book not found.');
  if (!isBookPrintFresh(book.status, book.layoutStale)) {
    return err('Prepare the print proof first — the book has changed since it was last rendered.');
  }
  if (!book.pageCount) {
    return err('Prepare the print proof first — the book has no rendered page count yet.');
  }
  const quote = await quoteBookPrice({
    format: book.format,
    coverType: book.coverType,
    pageCount: book.pageCount,
    recipient: quoteRecipientForCountry(country),
  });
  return { ok: true, value: quote };
}

/* ──────────────────────────────────────────────────────────────────────────
 * The pinned print file's public URL
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Gelato fetches the print file itself, and a `draft` order can sit in their dashboard for
 * weeks before someone converts it — longer than a presigned S3 URL can possibly live (7
 * days is SigV4's hard maximum). So the URL we hand over is one of ours, authenticated by
 * an HMAC of the order id rather than by a session (Gelato has no login):
 * `/api/book-orders/{orderId}/print-file?sig=…`. It never expires, and it only ever serves
 * that one order's pinned file.
 */
function printFileSig(orderId: string): string {
  return createHmac('sha256', env.BETTER_AUTH_SECRET).update(orderId).digest('hex');
}

export function printFileUrlFor(orderId: string): string {
  const base = env.BETTER_AUTH_URL.replace(/\/+$/, '');
  return `${base}/api/book-orders/${orderId}/print-file?sig=${printFileSig(orderId)}`;
}

/** Constant-time check of a `?sig=` against the order id it claims to be for. */
export function verifyPrintFileSig(orderId: string, sig: string | null | undefined): boolean {
  if (!sig) return false;
  const expected = Buffer.from(printFileSig(orderId), 'utf8');
  const given = Buffer.from(sig, 'utf8');
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

/* ──────────────────────────────────────────────────────────────────────────
 * Placing an order
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Place an order for a book: check the gate, price it against the real shipping address,
 * pin a private copy of the Gelato print file under `orders/{id}/`, lock the book, and
 * queue the worker job that actually submits it. Everything that can fail does so BEFORE
 * the row exists, so a failure never leaves a half-placed order behind.
 */
export async function placeBookOrder(input: {
  bookId: string;
  userId: string;
  userEmail: string | null | undefined;
  address: BookShippingAddress;
}): Promise<Result<{ orderId: string }>> {
  if (!canUserOrderBooks(input.userEmail)) {
    return err('Ordering in the app is not enabled for your account.');
  }
  const book = await getBookForUser(input.bookId, input.userId);
  if (!book) return err('Book not found.');

  // Only a LIVE order blocks a new one — a failed submission or a cancelled order is a
  // dead end the user is meant to be able to try again from.
  const live = await liveOrderRow(input.bookId);
  if (live) {
    return err('This book has already been ordered.');
  }
  if (book.status === 'ordered') {
    return err('This book has already been ordered.');
  }
  if (!isBookPrintFresh(book.status, book.layoutStale)) {
    return err('Prepare the print proof first — the book has changed since it was last rendered.');
  }
  if (!book.pageCount) {
    return err('Prepare the print proof first — the book has no rendered page count yet.');
  }
  if (book.pageCount > MAX_PAGES) {
    return err('This book has too many pages to be printed — Gelato photo books hold at most 200 pages.');
  }
  if (!book.gelatoS3Key) {
    return err('The print file for Gelato is missing — prepare the print proof again.');
  }
  if (book.hiddenChapterCount > 0) {
    return err(
      "Some of this book's chapters are stories you don't have access to — the print PDF contains every chapter, so only someone who can read all of them can render or order it.",
    );
  }

  const parsed = bookShippingAddressSchema.safeParse(input.address);
  if (!parsed.success) {
    return err('Please check the delivery address — some fields are missing or too long.');
  }
  const address: BookShippingAddress = parsed.data;

  const quote = await quoteBookPrice({
    format: book.format,
    coverType: book.coverType,
    pageCount: book.pageCount,
    recipient: address as GelatoRecipient,
  });
  if (!quote.priced || !quote.productUid) {
    return err('Could not get a live Gelato price for this address.');
  }

  // The id is generated up front so the pinned file can be written before any row
  // exists — a failed copy then leaves nothing behind but an unreferenced object.
  const orderId = randomUUID();
  const printFileS3Key = `orders/${orderId}/gelato.pdf`;
  try {
    const pdf = await getObjectBuffer(book.gelatoS3Key);
    await putObjectBuffer(printFileS3Key, pdf, 'application/pdf');
  } catch (e) {
    console.error(`[book-orders] could not pin the print file for book ${input.bookId}:`, e);
    return err('The print file could not be prepared for printing — please try again.');
  }

  try {
    await db.transaction(async (tx) => {
      await tx.insert(bookOrders).values({
        id: orderId,
        bookId: input.bookId,
        orderedBy: input.userId,
        quote,
        status: 'submitting',
        shippingAddress: address,
        printFileS3Key,
      });
      await tx
        .update(books)
        .set({ status: 'ordered', updatedAt: new Date() })
        .where(eq(books.id, input.bookId));
    });
  } catch (e) {
    // The row never landed, so nothing references the file we just pinned — drop it
    // rather than leaving an orphan in the bucket.
    await deleteObject(printFileS3Key).catch((cleanupError) => {
      console.error(`[book-orders] could not clean up ${printFileS3Key}:`, cleanupError);
    });
    // Two clicks raced and the other one won: `book_orders_open_uq` is the backstop the
    // "already ordered" check above can't be.
    if (isUniqueViolation(e)) return err('This book has already been ordered.');
    console.error(`[book-orders] could not write the order for book ${input.bookId}:`, e);
    return err('The order could not be placed — please try again.');
  }

  try {
    await enqueueSubmitBookOrder({ orderId });
  } catch (e) {
    // The row and the lock are already in place; without the job nothing would ever
    // submit it, so mark it failed, unlock the book, and let the retry path pick it up.
    console.error(`[book-orders] could not queue submission for order ${orderId}:`, e);
    await failOrder(orderId, input.bookId, 'The order could not be queued for submission.');
  }

  return { ok: true, value: { orderId } };
}

function truncate(message: string, max = 1000): string {
  return message.length > max ? `${message.slice(0, max - 1)}…` : message;
}

/** Best-effort admin notification — never allowed to affect the order's outcome. */
async function notifyAdmin(subject: string, text: string): Promise<void> {
  try {
    await sendEmail({ to: env.BOOK_ORDER_CONTACT_EMAIL, subject, text });
  } catch (e) {
    console.error('[book-orders] admin notification failed:', e);
  }
}

function addressSummary(a: BookShippingAddress): string {
  return [
    `${a.firstName} ${a.lastName}`,
    a.addressLine1,
    a.addressLine2,
    `${a.postCode} ${a.city}`,
    a.country,
    a.email,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Worker side: POST the pinned print file + recipient to Gelato, exactly once.
 *
 * Gelato's order creation is NOT idempotent (`orderReferenceId` doesn't dedupe), so the
 * `submit-book-order` queue runs with `retryLimit: 0` and this function claims the row
 * before doing anything else: ONE conditional UPDATE stamps `submit_started_at` only if
 * the row is still `submitting`, has no Gelato order, and hasn't been claimed. Whoever
 * loses that race gets no row back and returns. Never throws — a rethrow would only
 * produce a noisier log, and the row already records what went wrong.
 */
export async function submitBookOrder(orderId: string): Promise<void> {
  const [row] = await db
    .update(bookOrders)
    .set({ submitStartedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(bookOrders.id, orderId),
        eq(bookOrders.status, 'submitting'),
        isNull(bookOrders.gelatoOrderId),
        isNull(bookOrders.submitStartedAt),
      ),
    )
    .returning();
  if (!row) {
    console.log(`[book-orders] submit: order ${orderId} already claimed or not submittable — skipping`);
    return;
  }
  if (!row.printFileS3Key) {
    await failOrder(orderId, row.bookId, 'The pinned print file is missing.');
    return;
  }

  const [book] = await db
    .select({ title: books.title })
    .from(books)
    .where(eq(books.id, row.bookId))
    .limit(1);
  const title = book?.title ?? row.bookId;
  const quote = row.quote as BookQuote;
  const address = row.shippingAddress as BookShippingAddress | null;
  const orderUrl = `${env.BETTER_AUTH_URL}/books/${row.bookId}/order`;

  try {
    if (!address) throw new GelatoError('The order has no delivery address.');
    if (!quote?.productUid) throw new GelatoError('The order has no Gelato product.');
    // Gelato fetches the file itself, possibly weeks later (a draft order sits in their
    // dashboard until someone converts it), so hand over our own never-expiring signed
    // route. Locally that URL is a localhost address Gelato can't reach — fall back to a
    // presigned S3 link at its maximum SigV4 lifetime (7 days), which is enough for a
    // dev/staging test run.
    const fileUrl = env.BETTER_AUTH_URL.startsWith('https://')
      ? printFileUrlFor(row.id)
      : await presignGet(row.printFileS3Key, 'application/pdf', 7 * 24 * 3600);
    const gelatoOrder = await createGelatoOrder({
      orderReferenceId: row.id,
      customerReferenceId: row.orderedBy,
      productUid: quote.productUid,
      pageCount: quote.pageCount,
      fileUrl,
      recipient: address as GelatoRecipient,
    });

    const now = new Date();
    const mapped = mapGelatoStatus(gelatoOrder.fulfillmentStatus);
    // Never below `submitted`: Gelato has the order, whatever its early status says.
    const status = advanceStatus('submitted', mapped);
    await db
      .update(bookOrders)
      .set({
        gelatoOrderId: gelatoOrder.id,
        gelatoOrderType: gelatoOrder.orderType,
        gelatoStatus: gelatoOrder.fulfillmentStatus,
        status,
        errorMessage: null,
        trackingCode: gelatoOrder.trackingCode,
        trackingUrl: gelatoOrder.trackingUrl,
        submittedAt: now,
        statusCheckedAt: now,
        shippedAt: status === 'shipped' || status === 'delivered' ? now : null,
        deliveredAt: status === 'delivered' ? now : null,
        updatedAt: now,
      })
      .where(eq(bookOrders.id, orderId));

    console.log(`[book-orders] submitted order ${orderId} to Gelato as ${gelatoOrder.id} (${gelatoOrder.orderType})`);
    await notifyAdmin(
      `Book order submitted to Gelato: ${title}`,
      [
        `Book: ${title}`,
        `Gelato order: ${gelatoOrder.id} (${gelatoOrder.orderType}, ${gelatoOrder.fulfillmentStatus})`,
        `Total: ${quote.total != null ? `${quote.total} ${quote.currency}` : 'unknown'}`,
        '',
        'Recipient:',
        addressSummary(address),
        '',
        orderUrl,
      ].join('\n'),
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[book-orders] submitting order ${orderId} to Gelato failed:`, e);
    await failOrder(orderId, row.bookId, truncate(message));
    await notifyAdmin(
      `Book order FAILED to submit to Gelato: ${title}`,
      [`Book: ${title}`, `Order: ${orderId}`, '', `Error: ${truncate(message)}`, '', orderUrl].join('\n'),
    );
  }
}

/**
 * Re-queue a submission that gave up, without making the user retype the address. Only
 * for a `failed` order that never reached Gelato — once `gelatoOrderId` is set,
 * resubmitting would create a second real order.
 *
 * A failed order released the book, so everything that had to be true to place it has to
 * be true again: the book is still print-fresh, nobody else has ordered it in the
 * meantime, and it still has a Gelato print file. That file is re-pinned from the book's
 * CURRENT render (an edited-and-re-rendered book must print what it looks like now), and
 * if the re-render changed the page count the price is fetched again for the stored
 * address before the order goes back into the queue.
 */
export async function retryBookOrder(input: {
  orderId: string;
  userId: string;
  userEmail: string | null | undefined;
}): Promise<Result> {
  if (!canUserOrderBooks(input.userEmail)) {
    return err('Ordering in the app is not enabled for your account.');
  }
  const [row] = await db.select().from(bookOrders).where(eq(bookOrders.id, input.orderId)).limit(1);
  if (!row) return err('Order not found.');
  const book = await getBookForUser(row.bookId, input.userId);
  if (!book) return err('Order not found.');
  if (row.gelatoOrderId) return err('This order has already reached Gelato.');
  if (row.status !== 'failed') return err('Only a failed order can be submitted again.');

  const address = row.shippingAddress as BookShippingAddress | null;
  if (!address) return err('This order has no delivery address — please place it again.');

  // Someone else may have ordered the book while this one sat failed.
  const live = await liveOrderRow(row.bookId);
  if (live && live.id !== row.id) return err('This book has already been ordered.');

  if (!isBookPrintFresh(book.status, book.layoutStale)) {
    return err('Prepare the print proof first — the book has changed since it was last rendered.');
  }
  if (!book.pageCount) {
    return err('Prepare the print proof first — the book has no rendered page count yet.');
  }
  if (book.pageCount > MAX_PAGES) {
    return err('This book has too many pages to be printed — Gelato photo books hold at most 200 pages.');
  }
  if (!book.gelatoS3Key) {
    return err('The print file for Gelato is missing — prepare the print proof again.');
  }

  // Re-pin from the book's current render: between the failure and this retry the book
  // may have been edited and rendered again, and printing the older pinned copy would
  // hand Gelato a file that no longer matches the book (or the page count we quote).
  const printFileS3Key = row.printFileS3Key ?? `orders/${row.id}/gelato.pdf`;
  try {
    const pdf = await getObjectBuffer(book.gelatoS3Key);
    await putObjectBuffer(printFileS3Key, pdf, 'application/pdf');
  } catch (e) {
    console.error(`[book-orders] could not re-pin the print file for order ${row.id}:`, e);
    return err('The print file could not be prepared for printing — please try again.');
  }

  let quote = row.quote as BookQuote;
  if (quote?.pageCount !== book.pageCount) {
    const requoted = await quoteBookPrice({
      format: book.format,
      coverType: book.coverType,
      pageCount: book.pageCount,
      recipient: address as GelatoRecipient,
    });
    if (!requoted.priced || !requoted.productUid) {
      return err('Could not get a live Gelato price for this address.');
    }
    quote = requoted;
  }

  try {
    await db.transaction(async (tx) => {
      await tx
        .update(bookOrders)
        .set({
          status: 'submitting',
          submitStartedAt: null,
          errorMessage: null,
          quote,
          printFileS3Key,
          updatedAt: new Date(),
        })
        .where(eq(bookOrders.id, row.id));
      await tx
        .update(books)
        .set({ status: 'ordered', updatedAt: new Date() })
        .where(eq(books.id, row.bookId));
    });
  } catch (e) {
    if (isUniqueViolation(e)) return err('This book has already been ordered.');
    console.error(`[book-orders] could not re-open order ${row.id}:`, e);
    return err('The order could not be queued for submission — please try again.');
  }

  try {
    await enqueueSubmitBookOrder({ orderId: row.id });
  } catch (e) {
    console.error(`[book-orders] could not re-queue submission for order ${row.id}:`, e);
    await failOrder(row.id, row.bookId, 'The order could not be queued for submission.');
    return err('The order could not be queued for submission — please try again.');
  }
  return { ok: true };
}

/**
 * Ask Gelato where an order stands and write it back. Called lazily from
 * `getLatestBookOrder` (there is no webhook), so it runs inside a page render — hence the
 * short 5s timeout rather than the client's 20s default. Status only ever moves forward,
 * a cancellation hands the book back, and `statusCheckedAt` is bumped even when the call
 * fails so a permanently broken order doesn't hit Gelato on every single page view.
 */
export async function syncBookOrderStatus(orderId: string): Promise<void> {
  const [row] = await db.select().from(bookOrders).where(eq(bookOrders.id, orderId)).limit(1);
  if (!row?.gelatoOrderId) return;

  const now = new Date();
  try {
    const gelatoOrder = await getGelatoOrder(row.gelatoOrderId, { timeoutMs: 5000 });
    const current = row.status as BookOrderStatus;
    const status = advanceStatus(current, mapGelatoStatus(gelatoOrder.fulfillmentStatus));
    const reachedShipped = status === 'shipped' || status === 'delivered';
    await db.transaction(async (tx) => {
      await tx
        .update(bookOrders)
        .set({
          gelatoOrderType: gelatoOrder.orderType ?? row.gelatoOrderType,
          gelatoStatus: gelatoOrder.fulfillmentStatus,
          status,
          trackingCode: gelatoOrder.trackingCode ?? row.trackingCode,
          trackingUrl: gelatoOrder.trackingUrl ?? row.trackingUrl,
          shippedAt: reachedShipped ? (row.shippedAt ?? now) : row.shippedAt,
          deliveredAt: status === 'delivered' ? (row.deliveredAt ?? now) : row.deliveredAt,
          statusCheckedAt: now,
          updatedAt: now,
        })
        .where(eq(bookOrders.id, orderId));
      // Gelato cancelled or rejected it: the book is nobody's to print any more, so give
      // it back instead of leaving it locked at `ordered`.
      if (status === 'cancelled' || status === 'failed') {
        await releaseBook(row.bookId, tx);
      }
    });
  } catch (e) {
    console.error(`[book-orders] could not refresh Gelato status for order ${orderId}:`, e);
    await db
      .update(bookOrders)
      .set({ statusCheckedAt: now })
      .where(eq(bookOrders.id, orderId))
      .catch(() => {});
  }
}
