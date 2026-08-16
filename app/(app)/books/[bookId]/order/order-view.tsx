'use client';

import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Alert,
  Anchor,
  Button,
  Card,
  Divider,
  Group,
  Loader,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import {
  IconArrowLeft,
  IconDownload,
  IconFileTypePdf,
  IconInfoCircle,
  IconMail,
} from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { useI18n } from '@/lib/i18n/client';
import type { BookFormat, BookQuote } from '@/lib/gelato';
import type { BookKind, BookStatus } from '@/lib/books';
import type { BookOrderView } from '@/lib/book-orders';
import { isBookPrintFresh } from '@/lib/book-print-status';
import { quoteBookOrderAction, renderPreviewAction } from '../../actions';
import { OrderAddressForm } from './order-address-form';
import { OrderStatusCard } from './order-status-card';
import { PriceBreakdown, eur } from './order-price';
import { MAX_GELATO_PAGES, countryDestination } from './order-shared';
import posthog from 'posthog-js';

export interface OrderBook {
  id: string;
  title: string;
  kind: BookKind;
  format: BookFormat;
  formatLabel: string;
  pageCount: number;
  storyCount: number;
  /** Photo books only (`kind === 'photo'`) — how many photos are currently placed in the
   *  book (excluded ones don't count). Null for story books. */
  photoCount: number | null;
  status: BookStatus;
  /** True when the book's content/plan changed since its stored print PDF was rendered
   *  (`lib/books.ts`'s `BookDetail.layoutStale`). Photo books only — story books always
   *  downgrade `status` back to `draft` on any content change, so `preview_ready` alone
   *  means fresh for them (see `isBookPrintFresh`, `lib/book-print-status.ts`). */
  layoutStale: boolean;
  errorMessage: string | null;
  /** True when the viewer can't read every story in the book — the all-chapters
   *  print/order flow is off limits; the view explains why instead. Always false for
   *  photo books (docs/PHOTO_BOOK_PLAN.md §2 — no per-viewer hiding). */
  accessBlocked: boolean;
  /** True once a print PDF exists in S3 — gates the "Download PDF" button. */
  hasPrint: boolean;
}

/**
 * Everything the real (Gelato) ordering flow needs, bundled into one prop so the two
 * server pages that render `OrderView` — the standalone `/books/[bookId]/order` route
 * and the photo-book builder's step 3 — pass it as a single object instead of five
 * separate props threaded through the builder.
 *
 * When `canOrder` is false (every account except the few `canUserOrderBooks` allows) the
 * rest is ignored and the view keeps its original "email us to order" behavior exactly.
 */
export interface OrderingProps {
  /** `canUserOrderBooks(user.email)` — gates the in-app order form. */
  canOrder: boolean;
  /** Prefills the form's email field. */
  userEmail: string;
  /** Prefills first/last name, split on the last space. Null when the account has none. */
  userName: string | null;
  /** `Boolean(book.gelatoS3Key)` — the printer needs its own PDF variant; without it the
   *  view offers to create one instead of showing the form. */
  hasGelatoFile: boolean;
  /** `pageCount > MAX_GELATO_PAGES` — the printer can't bind a book this thick, so the
   *  view asks the user to shorten it instead of offering an order it would reject.
   *  Computed by both server pages from the same page count they price against. */
  tooLong: boolean;
  /** The book's most recent order, if it has one — replaces the ordering UI with the
   *  status card. */
  order: BookOrderView | null;
}

export function OrderView({
  book,
  quote,
  contactEmail,
  ordering,
  embedded = false,
}: {
  book: OrderBook;
  quote: BookQuote | null;
  contactEmail: string;
  ordering: OrderingProps;
  /** True when rendered inside the photo-book builder's own step 3 (photo-book-order-
   *  step.tsx), rather than the standalone `/books/[bookId]/order` route. Hides the "back
   *  to book"/page title (the stepper above already shows where we are) and this view's
   *  own simple download-PDF anchor (the step already renders a smarter one via the
   *  builder's `downloadPdf()`, which triggers a render first when the PDF is stale,
   *  rather than only appearing once one already exists). The standalone route never
   *  passes this, so its behavior/appearance there is completely unchanged. */
  embedded?: boolean;
}) {
  const { t } = useI18n();
  const to = t.books.order;
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  // The print proof render (`render-book`, ~1-2 minutes) is the one thing left in
  // this app that still needs server-side polling: the builder's preview is live
  // HTML now, but the exact page count + price need a real print PDF.
  useEffect(() => {
    if (book.accessBlocked || book.status !== 'rendering') return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/books/${book.id}/status`);
        if (!res.ok) return;
        const data = (await res.json()) as { status: string };
        if (data.status !== 'rendering') router.refresh();
      } catch {
        /* transient network error — next tick retries */
      }
    }, 4000);
    return () => clearInterval(timer);
  }, [book.accessBlocked, book.status, book.id, router]);

  // A placed order moves on without any client-side signal: `submitting` is a background
  // hand-off to Gelato (seconds), and everything after it changes at the printer's pace
  // and is only picked up when the server re-reads the order and lazily syncs it from
  // Gelato. So: refresh fast while the hand-off is in flight, slowly while the order is
  // live, and not at all once it has finished, failed or been cancelled.
  const orderStatus = ordering.order?.status;
  useEffect(() => {
    if (!orderStatus) return;
    if (orderStatus === 'delivered' || orderStatus === 'failed' || orderStatus === 'cancelled') {
      return;
    }
    const timer = setInterval(() => router.refresh(), orderStatus === 'submitting' ? 5000 : 60000);
    return () => clearInterval(timer);
  }, [orderStatus, router]);

  // For story books this is exactly the old `status !== 'preview_ready' && status !==
  // 'ordered'` check (unchanged behavior — `isBookPrintFresh` ignores `layoutStale` for
  // them, since their mutations already downgrade `status` back to `draft` on any
  // content change). For photo books it ALSO treats a `preview_ready` book with
  // `layoutStale: true` as still preparing — the narrow race where a mutation landed
  // while a render was already in flight (see `lib/book-print-status.ts`) — so the price
  // and Download button never show a PDF that predates the book's current content. That
  // falls into the same "preparing" UI below as any other not-yet-rendered state, and
  // reuses the same `preparePrintProof`/`renderPreviewAction` trigger and the `rendering`
  // status poll above.
  const preparing = !isBookPrintFresh(book.status, book.layoutStale);
  const priced = quote?.priced ?? false;
  const priceLine = priced && quote?.total != null ? eur(quote.total) : to.priceOnRequest;

  // The server-rendered `quote` is priced against a German address. Shipping costs differ
  // per country, so picking Austria or Switzerland in the form below re-quotes, and every
  // price on this screen — the breakdown rows and the "Order now" button — reads from that
  // result instead. Germany itself always keeps reading the server's own quote, so a
  // `router.refresh()` (after preparing the print proof, say) is never ignored.
  //
  // Results are cached, so switching back and forth costs no extra calls; a country whose
  // quote failed is cached as `null`, which reads as "no price for this country" rather
  // than as "not asked yet". The cache key carries the page count the server quoted for,
  // so an edit that changes the book's length can't leave an old price behind.
  const [country, setCountry] = useState<string>('DE');
  const [quotes, setQuotes] = useState<Record<string, BookQuote | null>>({});
  const [quoting, startQuoting] = useTransition();

  const cacheKey = (code: string) => `${code}:${quote?.pageCount ?? 'none'}`;
  const countryQuote = country === 'DE' ? quote : (quotes[cacheKey(country)] ?? null);
  // While a re-quote is in flight the new country has no numbers yet — keep the previous
  // rows on screen under the loader instead of flashing the "price on request" note.
  const shownQuote = countryQuote ?? (quoting ? quote : null);
  const countryQuoteFailed =
    country !== 'DE' && cacheKey(country) in quotes && !countryQuote?.priced;

  function changeCountry(next: string) {
    setCountry(next);
    if (next === 'DE' || cacheKey(next) in quotes) return;
    startQuoting(async () => {
      const result = await quoteBookOrderAction(book.id, next);
      setQuotes((prev) => ({ ...prev, [cacheKey(next)]: result.quote ?? null }));
    });
  }

  function preparePrintProof() {
    startTransition(async () => {
      const result = await renderPreviewAction(book.id);
      if (result.error) notifications.show({ message: result.error, color: 'red' });
    });
  }

  /** Renders the Gelato-format print file (the variant the printer needs, separate from
   *  the proof PDF the user downloads). Same render job as above, just asked to also
   *  produce that file — `router.refresh()` afterwards so `book.status` flips to
   *  `rendering` and the poll above takes over from there. */
  function createGelatoFile() {
    startTransition(async () => {
      const result = await renderPreviewAction(book.id, { ensureGelatoFile: true });
      if (result.error) {
        notifications.show({ message: result.error, color: 'red' });
        return;
      }
      router.refresh();
    });
  }

  // Everything the email needs, prefilled — the user just hits send.
  const mailSubject = to.mailSubject(book.title);
  const mailBody = [
    to.mailIntro(book.title),
    '',
    `${to.summaryReference}: ${book.id}`,
    `${to.summaryFormat}: ${book.formatLabel}`,
    `${to.summaryPages}: ${book.pageCount}`,
    `${to.summaryStories}: ${book.storyCount}`,
    `${to.total}: ${priceLine}`,
  ].join('\n');
  const mailtoHref = `mailto:${contactEmail}?subject=${encodeURIComponent(mailSubject)}&body=${encodeURIComponent(mailBody)}`;

  return (
    <Stack gap="md">
      {!embedded && (
        <>
          <Anchor component={Link} href={`/books/${book.id}`} fz={13} c="dimmed">
            <Group gap={4}>
              <IconArrowLeft size={14} />
              {to.backToBook}
            </Group>
          </Anchor>
          <Title order={1}>{to.title}</Title>
        </>
      )}

      {book.accessBlocked ? (
        <Alert color="yellow" icon={<IconInfoCircle size={16} />}>
          <Text fw={600} mb={2}>
            {to.hiddenChaptersTitle}
          </Text>
          <Text fz={13}>{to.hiddenChaptersBody}</Text>
        </Alert>
      ) : (
      <Card withBorder radius="md" p="lg">
        <Title order={3} mb="sm">
          {book.title}
        </Title>
        <Stack gap={6}>
          <Group justify="space-between">
            <Text c="dimmed">{to.summaryFormat}</Text>
            <Text>{book.formatLabel}</Text>
          </Group>
          <Group justify="space-between">
            <Text c="dimmed">{to.summaryPages}</Text>
            <Text>{book.pageCount}</Text>
          </Group>
          <Group justify="space-between">
            <Text c="dimmed">{book.kind === 'photo' ? to.summaryPhotos : to.summaryStories}</Text>
            <Text>{book.kind === 'photo' ? (book.photoCount ?? 0) : book.storyCount}</Text>
          </Group>
          <Group justify="space-between">
            <Text c="dimmed">{to.summaryReference}</Text>
            <Text ff="monospace" fz={12}>
              {book.id}
            </Text>
          </Group>
        </Stack>

        {/* Photo-book only (docs/PHOTO_BOOK_PLAN.md PR5, the v1 deliverable) — story
            books keep their existing order-screen behavior unchanged (no download link
            here yet; their PDF proof link lives on the builder page). Hidden when
            `embedded` — the builder's own step 3 already renders a smarter download
            button above this component (see `embedded`'s doc comment). */}
        {!embedded && book.kind === 'photo' && !preparing && book.hasPrint && (
          <Button
            component="a"
            href={`/api/books/${book.id}/print`}
            variant="light"
            size="sm"
            mt="sm"
            fullWidth
            leftSection={<IconDownload size={16} />}
            onClick={() =>
              posthog.__loaded &&
              posthog.capture('book_pdf_downloaded', { book_id: book.id, kind: book.kind })
            }
          >
            {to.downloadPdf}
          </Button>
        )}

        <Divider my="md" />

        {preparing ? (
          <Stack gap="sm">
            {book.status === 'render_failed' ? (
              <Alert color="red" icon={<IconInfoCircle size={16} />}>
                <Text fw={600} mb={2}>
                  {to.prepareFailedHint}
                </Text>
                {book.errorMessage && (
                  <Text fz={11} c="dimmed">
                    {book.errorMessage}
                  </Text>
                )}
              </Alert>
            ) : (
              <Alert color="blue" icon={<IconInfoCircle size={16} />}>
                <Text fw={600} mb={2}>
                  {to.preparingTitle}
                </Text>
                <Text fz={13}>{book.status === 'rendering' ? to.preparing : to.preparingBody}</Text>
              </Alert>
            )}
            {book.status === 'rendering' ? (
              <Group justify="center" py={4}>
                <Loader size="sm" />
              </Group>
            ) : (
              <Button loading={pending} onClick={preparePrintProof}>
                {book.status === 'render_failed' ? to.retry : to.prepareCta}
              </Button>
            )}
          </Stack>
        ) : shownQuote?.priced ? (
          <PriceBreakdown quote={shownQuote} country={country} loading={quoting} />
        ) : (
          <Alert color="yellow" icon={<IconInfoCircle size={16} />}>
            <Text fw={600} mb={2}>
              {to.priceOnRequest}
            </Text>
            <Text fz={13}>
              {countryQuoteFailed
                ? to.priceUnavailableCountry(countryDestination(to, country))
                : to.priceOnRequestHint}
            </Text>
          </Alert>
        )}
      </Card>
      )}

      {/* Once an order exists it outranks everything else here — including the `preparing`
          gate, so a placed order stays visible even if the book is mid-render for some
          other reason. */}
      {!book.accessBlocked && ordering.order ? (
        <OrderStatusCard order={ordering.order} />
      ) : !book.accessBlocked && !preparing ? (
        // The in-app order form is only for the few accounts `canUserOrderBooks` allows,
        // and only when there is a real price to charge against. Everyone else — and the
        // allowed accounts when the quote failed, so the owner is never stuck — keeps the
        // original "email us" flow below, unchanged.
        ordering.canOrder && ordering.tooLong ? (
          // Nothing to offer here: the printer can't bind a book this thick, and the
          // order would only be rejected. The download button in the card above stays,
          // so the PDF is still available.
          <Alert color="yellow" icon={<IconInfoCircle size={16} />}>
            <Text fw={600} mb={2}>
              {to.tooLongTitle}
            </Text>
            <Text fz={13}>{to.tooLongBody(MAX_GELATO_PAGES)}</Text>
          </Alert>
        ) : ordering.canOrder && priced && quote?.total != null ? (
          ordering.hasGelatoFile ? (
            <OrderAddressForm
              bookId={book.id}
              quote={countryQuote}
              quoting={quoting}
              country={country}
              onCountryChange={changeCountry}
              userEmail={ordering.userEmail}
              userName={ordering.userName}
            />
          ) : (
            <Alert color="yellow" icon={<IconInfoCircle size={16} />}>
              <Text fw={600} mb={2}>
                {to.printFileMissingTitle}
              </Text>
              <Text fz={13} mb="sm">
                {to.printFileMissingBody}
              </Text>
              <Button
                loading={pending}
                leftSection={<IconFileTypePdf size={16} />}
                onClick={createGelatoFile}
              >
                {to.createPrintFileCta}
              </Button>
            </Alert>
          )
        ) : (
          <>
            <Alert color="blue" icon={<IconInfoCircle size={16} />}>
              <Text fw={600} mb={2}>
                {to.howToOrderTitle}
              </Text>
              <Text fz={13}>{to.howToOrderBody(contactEmail)}</Text>
            </Alert>

            <Button
              size="lg"
              component="a"
              href={mailtoHref}
              leftSection={<IconMail size={18} />}
              onClick={() =>
                posthog.__loaded &&
                posthog.capture('book_order_email_opened', { book_id: book.id, format: book.format })
              }
            >
              {to.emailCta}
            </Button>
            <Text fz={12} c="dimmed" ta="center">
              {to.emailFallback(contactEmail)}
            </Text>
          </>
        )
      ) : null}
    </Stack>
  );
}
