'use client';

import { useEffect, useTransition } from 'react';
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
  IconInfoCircle,
  IconMail,
} from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { useI18n } from '@/lib/i18n/client';
import type { BookFormat, BookQuote } from '@/lib/gelato';
import type { BookKind, BookStatus } from '@/lib/books';
import { isBookPrintFresh } from '@/lib/book-print-status';
import { renderPreviewAction } from '../../actions';
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

const eur = (n: number) =>
  new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(n);

export function OrderView({
  book,
  quote,
  contactEmail,
  embedded = false,
}: {
  book: OrderBook;
  quote: BookQuote | null;
  contactEmail: string;
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

  function preparePrintProof() {
    startTransition(async () => {
      const result = await renderPreviewAction(book.id);
      if (result.error) notifications.show({ message: result.error, color: 'red' });
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
        ) : priced && quote ? (
          <Stack gap={6}>
            <Group justify="space-between">
              <Text c="dimmed">{to.printing}</Text>
              <Text>{eur(quote.productCost ?? 0)}</Text>
            </Group>
            <Group justify="space-between">
              <Text c="dimmed">{to.shipping}</Text>
              <Text>{eur(quote.shippingCost ?? 0)}</Text>
            </Group>
            <Group justify="space-between">
              <Text c="dimmed">{to.service}</Text>
              <Text>{eur(quote.margin)}</Text>
            </Group>
            <Divider my={4} />
            <Group justify="space-between">
              <Text fw={700}>{to.total}</Text>
              <Text fw={700} fz="lg">
                {eur(quote.total ?? 0)}
              </Text>
            </Group>
            <Text fz={12} c="dimmed">
              {to.inclShippingDe}
            </Text>
          </Stack>
        ) : (
          <Alert color="yellow" icon={<IconInfoCircle size={16} />}>
            <Text fw={600} mb={2}>
              {to.priceOnRequest}
            </Text>
            <Text fz={13}>{to.priceOnRequestHint}</Text>
          </Alert>
        )}
      </Card>
      )}

      {!book.accessBlocked && !preparing && (
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
      )}
    </Stack>
  );
}
