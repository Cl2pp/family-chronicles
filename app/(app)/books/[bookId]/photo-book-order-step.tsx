'use client';

import { Button, Card, Group, Stack, Text, Title } from '@mantine/core';
import { IconArrowLeft, IconDownload } from '@tabler/icons-react';
import { useI18n } from '@/lib/i18n/client';
import type { BookQuote } from '@/lib/gelato';
import { OrderView, type OrderBook } from './order/order-view';

/**
 * Step 3 — Order (docs/PHOTO_BOOK_PLAN.md, builder restructure): the final step. For
 * now this is the "Download PDF" flow (rendering the print PDF first if it's stale,
 * then downloading it — the smart version, ported from the old single-scroll builder)
 * plus the existing Gelato quote/mailto screen, embedded directly rather than sending
 * the user to the standalone `/books/[bookId]/order` route (which still works on its
 * own, unchanged, for anyone who has it bookmarked).
 */
export function PhotoBookOrderStep({
  order,
  quote,
  contactEmail,
  totalCount,
  downloadPdf,
  downloadRequesting,
  awaitingDownload,
  onBack,
}: {
  order: OrderBook;
  quote: BookQuote | null;
  contactEmail: string;
  totalCount: number;
  downloadPdf: () => void;
  downloadRequesting: boolean;
  awaitingDownload: boolean;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const tb = t.books.builder;
  const tp = tb.photoBook;

  return (
    <Stack gap="md">
      <Card withBorder radius="md" p="md">
        <Title order={4} mb={4}>
          {tp.steps.order}
        </Title>
        <Text fz={13} c="dimmed" mb="md">
          {tp.orderStepIntro}
        </Text>
        <Button
          variant="light"
          leftSection={<IconDownload size={16} />}
          loading={downloadRequesting || awaitingDownload}
          disabled={totalCount === 0}
          onClick={downloadPdf}
        >
          {tp.downloadPdf}
        </Button>
      </Card>

      <OrderView book={order} quote={quote} contactEmail={contactEmail} embedded />

      <Group>
        <Button variant="default" leftSection={<IconArrowLeft size={16} />} onClick={onBack}>
          {tp.back}
        </Button>
      </Group>
    </Stack>
  );
}
