import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { getBookForUser } from '@/lib/books';

/** Lightweight status poll for the builder while a render is running. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ bookId: string }> },
) {
  const { bookId } = await params;
  const session = await getSession();
  if (!session?.user) return new NextResponse('Unauthorized', { status: 401 });

  const book = await getBookForUser(bookId, session.user.id);
  if (!book) return new NextResponse('Not found', { status: 404 });

  return NextResponse.json({
    status: book.status,
    pageCount: book.pageCount,
    updatedAt: book.updatedAt,
  });
}
