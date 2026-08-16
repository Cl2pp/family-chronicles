'use client';

import { Divider, Group, Stack, Text } from '@mantine/core';
import { useI18n } from '@/lib/i18n/client';
import type { BookQuote } from '@/lib/gelato';

/** Prices are always euros and always shown in German number format, in both languages —
 *  the printer quotes in EUR and the app only ships to DE/AT/CH. */
export const eur = (n: number) =>
  new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(n);

/**
 * The printing / shipping / service / total rows. Shared by the pre-order price panel
 * (`order-view.tsx`, a live quote) and the placed-order card (`order-status-card.tsx`,
 * the quote frozen at order time) so both read identically.
 */
export function PriceBreakdown({ quote }: { quote: BookQuote }) {
  const { t } = useI18n();
  const to = t.books.order;

  return (
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
  );
}
