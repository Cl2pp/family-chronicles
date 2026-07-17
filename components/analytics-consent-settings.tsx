'use client';

import { Badge, Button, Group, Paper, Text } from '@mantine/core';
import { writeAnalyticsConsent, type AnalyticsConsent } from '@/lib/analytics-consent';
import { useAnalyticsConsent } from '@/lib/use-analytics-consent';
import { analyticsConfigured, startAnalytics, stopAnalytics } from '@/lib/posthog-client';

/**
 * Inline consent manager embedded in the Datenschutzerklärung, so withdrawing
 * consent is as easy as granting it (Art. 7 Abs. 3 DSGVO). German-only, like
 * the legal page around it.
 */
export function AnalyticsConsentSettings() {
  const consent = useAnalyticsConsent();

  if (!analyticsConfigured || consent === 'ssr') return null;

  function update(value: AnalyticsConsent) {
    writeAnalyticsConsent(value);
    if (value === 'granted') startAnalytics();
    else stopAnalytics();
  }

  const status =
    consent === 'granted' ? (
      <Badge color="green" variant="light">
        erteilt
      </Badge>
    ) : consent === 'denied' ? (
      <Badge color="red" variant="light">
        abgelehnt
      </Badge>
    ) : (
      <Badge color="gray" variant="light">
        noch nicht entschieden
      </Badge>
    );

  return (
    <Paper withBorder radius="md" p="md">
      <Group justify="space-between" wrap="wrap" gap="sm">
        <Text fz="sm" c="slate.7">
          Deine Einwilligung in die Nutzungsanalyse: {status}
        </Text>
        <Group gap="xs">
          <Button
            size="xs"
            variant="default"
            disabled={consent === 'denied'}
            onClick={() => update('denied')}
          >
            Widerrufen / Ablehnen
          </Button>
          <Button size="xs" disabled={consent === 'granted'} onClick={() => update('granted')}>
            Einwilligen
          </Button>
        </Group>
      </Group>
    </Paper>
  );
}
