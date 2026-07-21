import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { getBookForUser } from '@/lib/books';
import { getObjectBuffer } from '@/lib/s3';

/**
 * Access-checked delivery of the full-resolution, print-ready PDF the worker's
 * `render-book` job produces (`books.printS3Key`). For photo books this is the v1
 * "Download PDF" deliverable (docs/PHOTO_BOOK_PLAN.md §8/PR5) — the photo-book builder
 * and order page both link here once a fresh render exists. Story books get the same
 * route for free (no UI links to it yet — the story order/print flow is unchanged, see
 * `/preview` for its existing low-res PDF proof link), since the access rules below are
 * already exactly what a story book needs.
 *
 * Mirrors `app/api/books/[bookId]/preview/route.ts`: streamed through the route (not a
 * redirect to a presigned URL) so the browser can cache it by a stable ETag instead of
 * re-downloading on every visit, `Content-Disposition: attachment` so it always saves
 * to disk rather than opening inline.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ bookId: string }> },
) {
  const { bookId } = await params;
  const session = await getSession();
  if (!session?.user) return new NextResponse('Unauthorized', { status: 401 });

  const book = await getBookForUser(bookId, session.user.id);
  if (!book || !book.printS3Key) return new NextResponse('Not found', { status: 404 });
  // The PDF is a single artifact containing EVERY chapter — all-or-nothing: a viewer
  // who can't read all of the book's stories gets nothing (owners always qualify).
  // Always false for photo books (docs/PHOTO_BOOK_PLAN.md §2 — no per-viewer hiding).
  if (book.hiddenChapterCount > 0) return new NextResponse('Forbidden', { status: 403 });

  const etag = `"${bookId}-print-${book.updatedAt.getTime()}"`;
  const filename = `${book.title.replace(/[^\w\- ]+/g, '').trim() || 'book'}.pdf`;
  const headers = {
    ETag: etag,
    'Cache-Control': 'private, max-age=3600, must-revalidate',
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${filename}"`,
  };
  if (req.headers.get('if-none-match') === etag) {
    return new NextResponse(null, { status: 304, headers });
  }

  const pdf = await getObjectBuffer(book.printS3Key);
  return new NextResponse(new Uint8Array(pdf), { headers });
}
