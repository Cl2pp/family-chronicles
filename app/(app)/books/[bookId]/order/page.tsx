import { notFound } from 'next/navigation';
import { Box } from '@mantine/core';
import { requireUser } from '@/lib/session';
import { estimatePageCount, getBookForUser, listBookPhotos } from '@/lib/books';
import { isBookPrintFresh } from '@/lib/book-print-status';
import { bookEngineFor } from '@/lib/book-plan-kind';
import { quoteBookPrice, formatSummaryLabel } from '@/lib/gelato';
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
  // Photo books have no hidden-chapter concept (§2), so this is always false for them.
  const accessBlocked = book.hiddenChapterCount > 0;

  // Ordering needs a print-quality PDF as the binding proof (exact page count →
  // quote). draft/rendering/render_failed all render the "preparing" state instead
  // of a redirect — the builder's live HTML preview is no longer a stand-in for it,
  // so this is the one place left that triggers and waits for the print render.
  //
  // `fresh` gates both the page count and the quote on `isBookPrintFresh`, not just
  // `book.status`: for a photo book whose content changed since its stored print PDF
  // was rendered (`layoutStale`), `book.pageCount`/`book.printS3Key` describe a PDF that
  // no longer matches the book, so this falls back to a live estimate and skips the
  // quote exactly like a book that was never rendered at all (PR5 review, "order screen
  // can serve a stale print PDF for photo books"). Story books are unaffected —
  // `isBookPrintFresh` ignores `layoutStale` for them since their mutations already
  // downgrade `status` back to `draft` on any content change, so this is exactly the old
  // `book.pageCount ?? estimate` / `status === 'preview_ready' || status === 'ordered'`
  // behavior for `kind === 'story'`.
  const fresh = isBookPrintFresh(bookEngineFor(book.layoutPlan), book.status, book.layoutStale);
  const pageCount = fresh && book.pageCount != null ? book.pageCount : await estimatePageCount(book);
  const quote =
    !accessBlocked && fresh
      ? await quoteBookPrice({ format: book.format, coverType: book.coverType, pageCount })
      : null;

  // Photo books have no `chapters` to count (`book_stories` stays empty for them) — the
  // summary row shows photo count instead of story count.
  let photoCount: number | null = null;
  if (book.kind === 'photo') {
    const photosResult = await listBookPhotos(bookId, user.id);
    photoCount = photosResult.ok ? photosResult.value.photos.filter((p) => !p.excluded).length : 0;
  }

  return (
    <Box p="lg" maw={640} mx="auto">
      <OrderView
        book={{
          id: book.id,
          title: book.title,
    kind: book.kind,
    engine: bookEngineFor(book.layoutPlan),
          format: book.format,
          formatLabel: formatSummaryLabel(book.format, book.coverType),
          pageCount,
          storyCount: book.chapters.length,
          photoCount,
          status: book.status,
          layoutStale: book.layoutStale,
          errorMessage: book.errorMessage,
          accessBlocked,
          hasPrint: Boolean(book.printS3Key),
        }}
        quote={quote}
        contactEmail={env.BOOK_ORDER_CONTACT_EMAIL}
      />
    </Box>
  );
}
