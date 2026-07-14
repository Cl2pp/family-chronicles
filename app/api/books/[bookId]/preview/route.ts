import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { getBookForUser } from '@/lib/books';
import { presignGet } from '@/lib/s3';

/** Access-checked redirect to the (private) preview PDF in object storage. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ bookId: string }> },
) {
  const { bookId } = await params;
  const session = await getSession();
  if (!session?.user) return new NextResponse('Unauthorized', { status: 401 });

  const book = await getBookForUser(bookId, session.user.id);
  if (!book || !book.previewS3Key) return new NextResponse('Not found', { status: 404 });

  const url = await presignGet(book.previewS3Key, 'application/pdf');
  return NextResponse.redirect(url);
}
