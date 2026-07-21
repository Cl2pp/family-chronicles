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
  generatedAt,
  downloadPdf,
  downloadRequesting,
  awaitingDownload,
  onBack,
}: {
  order: OrderBook;
  quote: BookQuote | null;
  contactEmail: string;
  totalCount: number;
  /** `books.generated_at` — null means this book has never been through the explicit
   *  "Create book" design pass (`PhotoBookCreateStep`'s Step 2 gate). Ordering/downloading
   *  before that would silently hand out the plain auto-layout PDF, bypassing the whole
   *  configure→generate flow, so the primary action below requires it too — mirrors the
   *  step-navigation gate in `photo-book-builder.tsx`'s `goToStep`. */
  generatedAt: string | null;
  downloadPdf: () => void;
  downloadRequesting: boolean;
  awaitingDownload: boolean;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const tb = t.books.builder;
  const tp = tb.photoBook;
  const notGenerated = generatedAt == null;

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
          disabled={totalCount === 0 || notGenerated}
          onClick={downloadPdf}
        >
          {tp.downloadPdf}
        </Button>
        {notGenerated && (
          <Text fz={12} c="dimmed" mt={6}>
            {tp.waitingForGeneration}
          </Text>
        )}
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
