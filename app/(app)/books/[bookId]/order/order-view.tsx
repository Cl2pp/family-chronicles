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
  ThemeIcon,
  Title,
} from '@mantine/core';
import { IconArrowLeft, IconCircleCheck, IconInfoCircle } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { useI18n } from '@/lib/i18n/client';
import type { BookQuote } from '@/lib/gelato';
import type { BookStatus } from '@/lib/books';
import { placeOrderAction, renderPreviewAction } from '../../actions';

interface OrderBook {
  id: string;
  title: string;
  formatLabel: string;
  pageCount: number;
  storyCount: number;
  status: BookStatus;
  errorMessage: string | null;
}

const eur = (n: number) =>
  new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(n);

export function OrderView({
  book,
  quote,
  userEmail,
}: {
  book: OrderBook;
  quote: BookQuote | null;
  userEmail: string;
}) {
  const { t } = useI18n();
  const to = t.books.order;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirmed, setConfirmed] = useState(book.status === 'ordered');

  // The print proof render (`render-book`, ~1-2 minutes) is the one thing left in
  // this app that still needs server-side polling: the builder's preview is live
  // HTML now, but ordering is only unlocked once a real print PDF exists.
  useEffect(() => {
    if (book.status !== 'rendering') return;
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
  }, [book.status, book.id, router]);

  if (confirmed) {
    return (
      <Card withBorder radius="md" p="xl">
        <Stack align="center" gap="sm" py="md">
          <ThemeIcon size={56} radius="xl" color="teal" variant="light">
            <IconCircleCheck size={36} />
          </ThemeIcon>
          <Title order={2}>{to.confirmedTitle}</Title>
          <Text c="dimmed" ta="center" maw={400}>
            {to.confirmedBody(userEmail)}
          </Text>
          <Button component={Link} href="/books" variant="light" mt="sm">
            {to.backToBooks}
          </Button>
        </Stack>
      </Card>
    );
  }

  const preparing = book.status !== 'preview_ready';
  const priced = quote?.priced ?? false;

  function preparePrintProof() {
    startTransition(async () => {
      const result = await renderPreviewAction(book.id);
      if (result.error) notifications.show({ message: result.error, color: 'red' });
    });
  }

  return (
    <Stack gap="md">
      <Anchor component={Link} href={`/books/${book.id}`} fz={13} c="dimmed">
        <Group gap={4}>
          <IconArrowLeft size={14} />
          {to.backToBook}
        </Group>
      </Anchor>
      <Title order={1}>{to.title}</Title>

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

      {!preparing && (
        <>
          <Alert color="blue" icon={<IconInfoCircle size={16} />}>
            {to.noPaymentNote}
          </Alert>

          <Button
            size="lg"
            loading={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await placeOrderAction(book.id);
                if (result.error) {
                  notifications.show({ message: result.error, color: 'red' });
                } else {
                  setConfirmed(true);
                }
              })
            }
          >
            {priced && quote?.total != null ? to.orderAt(eur(quote.total)) : to.orderNow}
          </Button>
        </>
      )}
    </Stack>
  );
}
