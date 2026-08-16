'use client';

import { Box, Divider, Group, LoadingOverlay, Stack, Text } from '@mantine/core';
import { useI18n } from '@/lib/i18n/client';
import type { BookQuote } from '@/lib/gelato';
import { countryDestination } from './order-shared';

/** Prices are always euros and always shown in German number format, in both languages —
 *  the printer quotes in EUR and the app only ships to DE/AT/CH. */
export const eur = (n: number) =>
  new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(n);

/**
 * The printing / shipping / service / total rows. Shared by the pre-order price panel
 * (`order-view.tsx`, a live quote) and the placed-order card (`order-status-card.tsx`,
 * the quote frozen at order time) so both read identically.
 *
 * Shipping is priced per destination country, so the rows name the country the quote was
 * made for rather than always claiming Germany.
 */
export function PriceBreakdown({
  quote,
  country,
  loading = false,
}: {
  quote: BookQuote;
  /** Two-letter code of the country this quote was made for — names the shipping line. */
  country: string;
  /** True while a re-quote for a newly picked country is in flight. The rows below still
   *  hold the previous country's numbers, so they get covered rather than read as the
   *  new country's price. */
  loading?: boolean;
}) {
  const { t } = useI18n();
  const to = t.books.order;

  // Germany keeps its original wording ("within Germany") — it reads better than "to
  // Germany", and it leaves the text of the unchanged mailto flow exactly as it was.
  const destination = countryDestination(to, country);
  const shippingLabel = country === 'DE' ? to.shipping : to.shippingTo(destination);
  const inclShippingLabel = country === 'DE' ? to.inclShippingDe : to.inclShippingTo(destination);

  return (
    <Box pos="relative">
      <LoadingOverlay
        visible={loading}
        zIndex={1}
        loaderProps={{ size: 'sm' }}
        overlayProps={{ blur: 1 }}
      />
      <Stack gap={6}>
        <Group justify="space-between">
          <Text c="dimmed">{to.printing}</Text>
          <Text>{eur(quote.productCost ?? 0)}</Text>
        </Group>
        <Group justify="space-between">
          <Text c="dimmed">{shippingLabel}</Text>
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
          {inclShippingLabel}
        </Text>
      </Stack>
    </Box>
  );
}
