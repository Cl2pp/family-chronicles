import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { bookOrders } from '@/db/schema';
import { verifyPrintFileSig } from '@/lib/book-orders';
import { getObjectBuffer } from '@/lib/s3';

/**
 * The print file Gelato downloads (`lib/book-orders.ts`'s `printFileUrlFor`).
 *
 * Gelato fetches the PDF itself, and a `draft` order can sit in their dashboard for weeks
 * before someone converts it — well past the 7 days a presigned S3 link can live. So the
 * URL handed over is this route, authenticated by an HMAC of the order id rather than by a
 * session: Gelato has no login and never will. The signature is derived from
 * BETTER_AUTH_SECRET, so it can't be guessed, and it authorises exactly one order.
 *
 * It only ever serves that order's own pinned file (`book_orders.print_file_s3_key`,
 * always `orders/{orderId}/gelato.pdf`) — the S3 key is read from the row, never from the
 * request, so a valid signature for one order cannot reach another order's file or
 * anything else in the bucket. Anything that doesn't line up is a flat 404: no hint about
 * whether the order exists.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const notFound = () => new NextResponse('Not found', { status: 404 });

export async function GET(req: Request, { params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  if (!UUID.test(orderId)) return notFound();
  const sig = new URL(req.url).searchParams.get('sig');
  if (!verifyPrintFileSig(orderId, sig)) return notFound();

  const [row] = await db
    .select({ printFileS3Key: bookOrders.printFileS3Key })
    .from(bookOrders)
    .where(eq(bookOrders.id, orderId))
    .limit(1);
  if (!row?.printFileS3Key) return notFound();

  try {
    const pdf = await getObjectBuffer(row.printFileS3Key);
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': String(pdf.length),
        'Content-Disposition': `inline; filename="familienwerk-${orderId}.pdf"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    console.error(`[book-orders] could not serve the print file for order ${orderId}:`, e);
    return notFound();
  }
}
