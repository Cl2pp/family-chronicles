import { notFound, redirect } from 'next/navigation';
import { Box } from '@mantine/core';
import { requireUser } from '@/lib/session';
import { estimatePageCount, getBookForUser } from '@/lib/books';
import { quoteBookPrice, FORMAT_LABELS } from '@/lib/gelato';
import { OrderView } from './order-view';

export default async function OrderPage({ params }: { params: Promise<{ bookId: string }> }) {
  const { bookId } = await params;
  const user = await requireUser();
  const book = await getBookForUser(bookId, user.id);
  if (!book) notFound();
  // Ordering needs a reviewed preview; already-ordered books show the confirmation.
  if (book.status !== 'preview_ready' && book.status !== 'ordered') {
    redirect(`/books/${bookId}`);
  }

  const pageCount = book.pageCount ?? estimatePageCount(book);
  const quote =
    book.status === 'ordered' ? null : await quoteBookPrice({ format: book.format, pageCount });

  return (
    <Box p="lg" maw={640} mx="auto">
      <OrderView
        book={{
          id: book.id,
          title: book.title,
          formatLabel: FORMAT_LABELS[book.format],
          pageCount,
          storyCount: book.chapters.length,
          ordered: book.status === 'ordered',
        }}
        quote={quote}
        userEmail={user.email}
      />
    </Box>
  );
}
