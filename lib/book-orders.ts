import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
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
  type BookOrderStatus,
  type BookQuote,
  type GelatoRecipient,
} from '@/lib/gelato';
import { enqueueSubmitBookOrder } from '@/lib/queue';
import { sendEmail } from '@/lib/email';
import { getObjectBuffer, presignGet, putObjectBuffer } from '@/lib/s3';

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
 * `submit-book-order` → `submitBookOrder` (worker) POSTs it to Gelato exactly once →
 * `syncBookOrderStatus` (lazily, from the order page) keeps status + tracking fresh.
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

/** Whether this account may order books in the app at all (`BOOK_ORDERING_ALLOWED_EMAILS`,
 *  already lowercased by lib/env.ts). Empty list = nobody. */
export function canUserOrderBooks(email: string | null | undefined): boolean {
  if (!email) return false;
  return env.BOOK_ORDERING_ALLOWED_EMAILS.includes(email.trim().toLowerCase());
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

/** `failed`/`cancelled` are terminal verdicts and always win; otherwise only forward. */
function advanceStatus(current: BookOrderStatus, next: BookOrderStatus): BookOrderStatus {
  if (next === 'failed' || next === 'cancelled') return next;
  if (current === 'failed' || current === 'cancelled') return current;
  return STATUS_RANK[next] > STATUS_RANK[current] ? next : current;
}

/** Statuses worth asking Gelato about again. */
const POLLABLE: BookOrderStatus[] = ['submitted', 'in_production', 'shipped'];

/** How stale a `statusCheckedAt` may be before the order page re-polls Gelato. */
const STATUS_POLL_MAX_AGE_MS = 2 * 60 * 1000;
/** See `getLatestBookOrder` — a `submitting` row older than this is declared dead. */
const SUBMITTING_TIMEOUT_MS = 10 * 60 * 1000;

type OrderRow = typeof bookOrders.$inferSelect;

function toView(row: OrderRow): BookOrderView {
  const gelatoStatus = row.gelatoStatus;
  return {
    id: row.id,
    bookId: row.bookId,
    status: row.status as BookOrderStatus,
    orderType: gelatoStatus === 'draft' ? 'draft' : row.gelatoOrderId ? 'order' : null,
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
  // POST times out after 1, so after SUBMITTING_TIMEOUT_MS nothing is still running —
  // flip it to `failed` so the order page offers "Try again". If the POST did go
  // through and only the write-back was lost, the retry creates a second Gelato order
  // (visible in their dashboard; a draft when GELATO_ORDER_TYPE=draft) — say so.
  if (
    row.status === 'submitting' &&
    !row.gelatoOrderId &&
    Date.now() - row.updatedAt.getTime() > SUBMITTING_TIMEOUT_MS
  ) {
    await db
      .update(bookOrders)
      .set({
        status: 'failed',
        errorMessage:
          'The submission to Gelato did not finish in time. Check the Gelato dashboard for a matching order before trying again.',
        updatedAt: new Date(),
      })
      .where(and(eq(bookOrders.id, row.id), eq(bookOrders.status, 'submitting')));
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

  const existing = await latestOrderRow(input.bookId);
  if (existing && existing.status !== 'cancelled') {
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

  try {
    await enqueueSubmitBookOrder({ orderId });
  } catch (e) {
    // The row and the lock are already in place; without the job nothing would ever
    // submit it, so mark it failed and let the retry path pick it up.
    console.error(`[book-orders] could not queue submission for order ${orderId}:`, e);
    await db
      .update(bookOrders)
      .set({
        status: 'failed',
        errorMessage: 'The order could not be queued for submission.',
        updatedAt: new Date(),
      })
      .where(eq(bookOrders.id, orderId));
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
 * `submit-book-order` queue runs with `retryLimit: 0` and this function refuses to run
 * twice: an order that already has a `gelatoOrderId`, or that isn't `submitting`, is left
 * alone. Never throws — a rethrow would only produce a noisier log, and the row already
 * records what went wrong.
 */
export async function submitBookOrder(orderId: string): Promise<void> {
  const [row] = await db.select().from(bookOrders).where(eq(bookOrders.id, orderId)).limit(1);
  if (!row) {
    console.error(`[book-orders] submit: order ${orderId} not found`);
    return;
  }
  if (row.gelatoOrderId) {
    console.log(`[book-orders] submit: order ${orderId} already has Gelato order ${row.gelatoOrderId} — skipping`);
    return;
  }
  if (row.status !== 'submitting') {
    console.log(`[book-orders] submit: order ${orderId} is '${row.status}', not 'submitting' — skipping`);
    return;
  }
  if (!row.printFileS3Key) {
    await db
      .update(bookOrders)
      .set({ status: 'failed', errorMessage: 'The pinned print file is missing.', updatedAt: new Date() })
      .where(eq(bookOrders.id, orderId));
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
    // Gelato fetches the file itself, possibly a while after we hand it over — sign for
    // the maximum SigV4 lifetime (7 days) rather than the default hour.
    const fileUrl = await presignGet(row.printFileS3Key, 'application/pdf', 7 * 24 * 3600);
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
    await db
      .update(bookOrders)
      .set({ status: 'failed', errorMessage: truncate(message), updatedAt: new Date() })
      .where(eq(bookOrders.id, orderId));
    await notifyAdmin(
      `Book order FAILED to submit to Gelato: ${title}`,
      [`Book: ${title}`, `Order: ${orderId}`, '', `Error: ${truncate(message)}`, '', orderUrl].join('\n'),
    );
  }
}

/**
 * Re-queue a submission that gave up. Only for a `failed` order that never reached
 * Gelato — once `gelatoOrderId` is set, resubmitting would create a second real order.
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

  await db
    .update(bookOrders)
    .set({ status: 'submitting', errorMessage: null, updatedAt: new Date() })
    .where(eq(bookOrders.id, input.orderId));
  try {
    await enqueueSubmitBookOrder({ orderId: input.orderId });
  } catch (e) {
    console.error(`[book-orders] could not re-queue submission for order ${input.orderId}:`, e);
    await db
      .update(bookOrders)
      .set({
        status: 'failed',
        errorMessage: 'The order could not be queued for submission.',
        updatedAt: new Date(),
      })
      .where(eq(bookOrders.id, input.orderId));
    return err('The order could not be queued for submission — please try again.');
  }
  return { ok: true };
}

/**
 * Ask Gelato where an order stands and write it back. Called lazily from
 * `getLatestBookOrder` (there is no webhook). Status only ever moves forward, and
 * `statusCheckedAt` is bumped even when the call fails so a permanently broken order
 * doesn't hit Gelato on every single page view.
 */
export async function syncBookOrderStatus(orderId: string): Promise<void> {
  const [row] = await db.select().from(bookOrders).where(eq(bookOrders.id, orderId)).limit(1);
  if (!row?.gelatoOrderId) return;

  const now = new Date();
  try {
    const gelatoOrder = await getGelatoOrder(row.gelatoOrderId);
    const current = row.status as BookOrderStatus;
    const status = advanceStatus(current, mapGelatoStatus(gelatoOrder.fulfillmentStatus));
    const reachedShipped = status === 'shipped' || status === 'delivered';
    await db
      .update(bookOrders)
      .set({
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
  } catch (e) {
    console.error(`[book-orders] could not refresh Gelato status for order ${orderId}:`, e);
    await db
      .update(bookOrders)
      .set({ statusCheckedAt: now })
      .where(eq(bookOrders.id, orderId))
      .catch(() => {});
  }
}
