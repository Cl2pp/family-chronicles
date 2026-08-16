'use client';

import { useTransition } from 'react';
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
  Timeline,
  Title,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconCheck,
  IconInfoCircle,
  IconPackage,
  IconPrinter,
  IconSend,
  IconTruck,
} from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { useI18n } from '@/lib/i18n/client';
import type { BookOrderView } from '@/lib/book-orders';
import { retryBookOrderAction } from '../../actions';
import { PriceBreakdown } from './order-price';
import { countryLabel } from './order-shared';

/** How far along the timeline each status is. `failed`/`cancelled` never reach the
 *  timeline (they render their own alert instead), so they aren't in here. */
const STEP_INDEX: Record<string, number> = {
  submitting: 0,
  submitted: 1,
  in_production: 2,
  shipped: 3,
  delivered: 4,
};

/**
 * What the user sees once an order exists for this book, in place of the "email us"
 * block: where the order is, what it cost, and where it's going.
 *
 * Status comes from `book_orders` and is lazily refreshed from Gelato server-side on
 * every page load, so the view just has to keep asking for a fresh render — see the poll
 * in `order-view.tsx`.
 */
export function OrderStatusCard({ order }: { order: BookOrderView }) {
  const { locale, t } = useI18n();
  const to = t.books.order;
  const router = useRouter();
  const [retrying, startRetry] = useTransition();

  const dateFormat = new Intl.DateTimeFormat(locale === 'de' ? 'de-DE' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  const failed = order.status === 'failed';
  const cancelled = order.status === 'cancelled';
  const address = order.shippingAddress;

  function retry() {
    startRetry(async () => {
      const result = await retryBookOrderAction(order.bookId, order.id);
      if (result.error) {
        notifications.show({ message: result.error, color: 'red' });
        return;
      }
      router.refresh();
    });
  }

  return (
    <Card withBorder radius="md" p="lg">
      <Title order={4} mb="md">
        {to.orderStatusTitle}
      </Title>

      {failed ? (
        <Stack gap="sm">
          <Alert color="red" icon={<IconAlertTriangle size={16} />}>
            <Text fw={600} mb={2}>
              {to.orderFailedTitle}
            </Text>
            <Text fz={13}>{to.orderFailedBody}</Text>
            {order.errorMessage && (
              <Text fz={11} c="dimmed" mt={4}>
                {order.errorMessage}
              </Text>
            )}
          </Alert>
          <Button loading={retrying} onClick={retry}>
            {to.retry}
          </Button>
        </Stack>
      ) : cancelled ? (
        <Alert color="gray" icon={<IconInfoCircle size={16} />}>
          <Text fw={600} mb={2}>
            {to.orderCancelledTitle}
          </Text>
          <Text fz={13}>{to.orderCancelledBody}</Text>
        </Alert>
      ) : (
        <Timeline active={STEP_INDEX[order.status] ?? 0} bulletSize={24} lineWidth={2}>
          <Timeline.Item bullet={<IconCheck size={13} />} title={to.stepPlaced}>
            <Text fz={12} c="dimmed">
              {dateFormat.format(new Date(order.createdAt))}
            </Text>
            {order.status === 'submitting' && (
              <Group gap={8} mt={6}>
                <Loader size="xs" />
                <Text fz={12} c="dimmed">
                  {to.orderSubmitting}
                </Text>
              </Group>
            )}
          </Timeline.Item>

          <Timeline.Item bullet={<IconSend size={13} />} title={to.stepSubmitted}>
            {order.submittedAt && (
              <Text fz={12} c="dimmed">
                {dateFormat.format(new Date(order.submittedAt))}
              </Text>
            )}
            {/* A `draft` order sits in the Gelato dashboard until it's confirmed there —
                nothing is printed until then, so say so rather than implying it's done. */}
            {order.orderType === 'draft' && (
              <Text fz={12} c="dimmed" mt={2}>
                {to.stepSubmittedDraft}
              </Text>
            )}
          </Timeline.Item>

          <Timeline.Item bullet={<IconPrinter size={13} />} title={to.stepInProduction} />

          <Timeline.Item bullet={<IconTruck size={13} />} title={to.stepShipped}>
            {order.shippedAt && (
              <Text fz={12} c="dimmed">
                {dateFormat.format(new Date(order.shippedAt))}
              </Text>
            )}
            {order.trackingCode && (
              <Text fz={12} c="dimmed">
                {to.orderTracking}:{' '}
                {order.trackingUrl ? (
                  <Anchor href={order.trackingUrl} target="_blank" rel="noopener noreferrer" fz={12}>
                    {order.trackingCode}
                  </Anchor>
                ) : (
                  <Text component="span" ff="monospace" fz={12}>
                    {order.trackingCode}
                  </Text>
                )}
              </Text>
            )}
            {!order.trackingCode && order.trackingUrl && (
              <Anchor href={order.trackingUrl} target="_blank" rel="noopener noreferrer" fz={12}>
                {to.orderTrackOpen}
              </Anchor>
            )}
          </Timeline.Item>

          <Timeline.Item bullet={<IconPackage size={13} />} title={to.stepDelivered}>
            {order.deliveredAt && (
              <Text fz={12} c="dimmed">
                {dateFormat.format(new Date(order.deliveredAt))}
              </Text>
            )}
          </Timeline.Item>
        </Timeline>
      )}

      <Divider my="md" />

      <Stack gap={6}>
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Text c="dimmed">{to.orderPlacedOn}</Text>
          <Text ta="right">{dateFormat.format(new Date(order.createdAt))}</Text>
        </Group>
        {order.gelatoOrderId && (
          <Group justify="space-between" align="flex-start" wrap="nowrap">
            <Text c="dimmed">{to.orderPrinterReference}</Text>
            <Text ff="monospace" fz={12} ta="right" style={{ wordBreak: 'break-all' }}>
              {order.gelatoOrderId}
            </Text>
          </Group>
        )}
        {address && (
          <Group justify="space-between" align="flex-start" wrap="nowrap">
            <Text c="dimmed">{to.orderShipTo}</Text>
            <Text fz={13} ta="right">
              {`${address.firstName} ${address.lastName}`}
              <br />
              {address.addressLine1}
              {address.addressLine2 && (
                <>
                  <br />
                  {address.addressLine2}
                </>
              )}
              <br />
              {`${address.postCode} ${address.city}`}
              <br />
              {countryLabel(to, address.country)}
            </Text>
          </Group>
        )}
      </Stack>

      <Divider my="md" />

      {/* The quote as it stood when the order was placed — not a fresh one, so the total
          shown here always matches what was actually ordered. */}
      <PriceBreakdown quote={order.quote} />
    </Card>
  );
}
