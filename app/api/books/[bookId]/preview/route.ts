import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { getBookForUser } from '@/lib/books';
import { getObjectBuffer } from '@/lib/s3';

/**
 * Access-checked delivery of the (private) preview PDF.
 *
 * Streamed through the route rather than redirected to a presigned URL: a
 * presigned URL is different on every request, so the browser could never
 * cache the PDF and re-downloaded it on every builder visit. Here the ETag is
 * stable until the book changes (the iframe also carries ?v=updatedAt), so
 * repeat visits get a bodyless 304 instead of megabytes of PDF.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ bookId: string }> },
) {
  const { bookId } = await params;
  const session = await getSession();
  if (!session?.user) return new NextResponse('Unauthorized', { status: 401 });

  const book = await getBookForUser(bookId, session.user.id);
  if (!book || !book.previewS3Key) return new NextResponse('Not found', { status: 404 });

  const etag = `"${bookId}-${book.updatedAt.getTime()}"`;
  const headers = {
    ETag: etag,
    'Cache-Control': 'private, max-age=3600, must-revalidate',
    'Content-Type': 'application/pdf',
  };
  if (req.headers.get('if-none-match') === etag) {
    return new NextResponse(null, { status: 304, headers });
  }

  const pdf = await getObjectBuffer(book.previewS3Key);
  return new NextResponse(new Uint8Array(pdf), { headers });
}
