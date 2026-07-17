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
import { IconArrowLeft, IconInfoCircle, IconMail } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { useI18n } from '@/lib/i18n/client';
import type { BookQuote } from '@/lib/gelato';
import type { BookStatus } from '@/lib/books';
import { renderPreviewAction } from '../../actions';
import posthog from 'posthog-js';

interface OrderBook {
  id: string;
  title: string;
  formatLabel: string;
  pageCount: number;
  storyCount: number;
  status: BookStatus;
  errorMessage: string | null;
  /** True when the viewer can't read every story in the book — the all-chapters
   *  print/order flow is off limits; the view explains why instead. */
  accessBlocked: boolean;
}

const eur = (n: number) =>
  new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(n);

export function OrderView({
  book,
  quote,
  contactEmail,
}: {
  book: OrderBook;
  quote: BookQuote | null;
  contactEmail: string;
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

  const preparing = book.status !== 'preview_ready' && book.status !== 'ordered';
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
      <Anchor component={Link} href={`/books/${book.id}`} fz={13} c="dimmed">
        <Group gap={4}>
          <IconArrowLeft size={14} />
          {to.backToBook}
        </Group>
      </Anchor>
      <Title order={1}>{to.title}</Title>

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
            <Text c="dimmed">{to.summaryStories}</Text>
            <Text>{book.storyCount}</Text>
          </Group>
          <Group justify="space-between">
            <Text c="dimmed">{to.summaryReference}</Text>
            <Text ff="monospace" fz={12}>
              {book.id}
            </Text>
          </Group>
        </Stack>

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
            onClick={() => posthog.capture('book_order_email_opened', { bookId: book.id, format: book.formatLabel })}
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
