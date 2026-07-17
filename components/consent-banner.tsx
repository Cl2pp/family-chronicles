'use client';

import { Anchor, Button, Group, Paper, Portal, Stack, Text } from '@mantine/core';
import { writeAnalyticsConsent, type AnalyticsConsent } from '@/lib/analytics-consent';
import { useAnalyticsConsent } from '@/lib/use-analytics-consent';
import { analyticsConfigured, startAnalytics } from '@/lib/posthog-client';
import { useI18n } from '@/lib/i18n/client';

/**
 * Opt-in banner for PostHog analytics (§ 25 Abs. 1 TDDDG / Art. 6 Abs. 1
 * lit. a DSGVO). Shows only while no choice is stored and analytics is
 * configured at all; the choice can be changed any time on /datenschutz
 * (components/analytics-consent-settings.tsx).
 */
export function ConsentBanner() {
  const { t } = useI18n();
  // null = no stored choice yet (browser only — 'ssr' during server render).
  const consent = useAnalyticsConsent();

  if (!analyticsConfigured || consent !== null) return null;

  function decide(value: AnalyticsConsent) {
    writeAnalyticsConsent(value);
    if (value === 'granted') startAnalytics();
  }

  return (
    <Portal>
      <Paper
        withBorder
        shadow="md"
        radius="md"
        p="md"
        style={{
          position: 'fixed',
          bottom: 16,
          left: 16,
          right: 16,
          maxWidth: 440,
          marginLeft: 'auto',
          zIndex: 400,
        }}
      >
        <Stack gap="xs">
          <Text fw={600} fz="sm">
            {t.consent.title}
          </Text>
          <Text fz="sm" c="dimmed">
            {t.consent.body}{' '}
            <Anchor href="/datenschutz" fz="sm">
              {t.consent.privacyLink}
            </Anchor>
          </Text>
          <Group justify="flex-end" gap="xs">
            <Button variant="default" size="xs" onClick={() => decide('denied')}>
              {t.consent.decline}
            </Button>
            <Button size="xs" onClick={() => decide('granted')}>
              {t.consent.accept}
            </Button>
          </Group>
        </Stack>
      </Paper>
    </Portal>
  );
}
