import { notFound } from 'next/navigation';
import { Box } from '@mantine/core';
import { requireUser } from '@/lib/session';
import { estimatePageCount, getBookForUser } from '@/lib/books';
import { quoteBookPrice, FORMAT_LABELS } from '@/lib/gelato';
import { env } from '@/lib/env';
import { OrderView } from './order-view';

export default async function OrderPage({ params }: { params: Promise<{ bookId: string }> }) {
  const { bookId } = await params;
  const user = await requireUser();
  const book = await getBookForUser(bookId, user.id);
  if (!book) notFound();

  // All-or-nothing: the print PDF contains every chapter, so a viewer who can't
  // read all of the book's stories can neither trigger the render nor order —
  // the view shows an explanatory note instead (owners always see everything).
  const accessBlocked = book.hiddenChapterCount > 0;

  // Ordering needs a print-quality PDF as the binding proof (exact page count →
  // quote). draft/rendering/render_failed all render the "preparing" state instead
  // of a redirect — the builder's live HTML preview is no longer a stand-in for it,
  // so this is the one place left that triggers and waits for the print render.
  const pageCount = book.pageCount ?? estimatePageCount(book);
  const quote =
    !accessBlocked && (book.status === 'preview_ready' || book.status === 'ordered')
      ? await quoteBookPrice({ format: book.format, pageCount })
      : null;

  return (
    <Box p="lg" maw={640} mx="auto">
      <OrderView
        book={{
          id: book.id,
          title: book.title,
          formatLabel: FORMAT_LABELS[book.format],
          pageCount,
          storyCount: book.chapters.length,
          status: book.status,
          errorMessage: book.errorMessage,
          accessBlocked,
        }}
        quote={quote}
        contactEmail={env.BOOK_ORDER_CONTACT_EMAIL}
      />
    </Box>
  );
}
