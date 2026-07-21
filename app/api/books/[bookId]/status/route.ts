import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { getBookForUser } from '@/lib/books';
import { isDesignInFlight, parseDesignStage } from '@/lib/photo-book-design-stage';

/** Lightweight status poll for the builder while a render or an AI design pass is running. */
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
    designing: isDesignInFlight(book.designRequestedAt),
    // Photo books only — how far the running design pass has got, so the builder can tick
    // its progress checklist off live instead of showing an indefinite spinner.
    designStage: parseDesignStage(book.designStage),
  });
}
