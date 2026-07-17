import posthog from 'posthog-js';
import { readAnalyticsConsent } from '@/lib/analytics-consent';

// Must read process.env directly (not lib/env.ts): Next.js only inlines
// NEXT_PUBLIC_* into the client bundle on static process.env references.
export const analyticsConfigured = Boolean(process.env.NEXT_PUBLIC_POSTHOG_KEY);

/**
 * Browser-side PostHog bootstrap. Called from instrumentation-client.ts (page
 * load with stored consent) and from the consent UI the moment consent is
 * granted. Never call it without consent — initializing is what sets PostHog's
 * cookies (§ 25 Abs. 1 TDDDG).
 */
export function startAnalytics(): void {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key || posthog.__loaded) return;
  if (readAnalyticsConsent() !== 'granted') return;
  posthog.init(key, {
    api_host: '/ingest',
    ui_host: 'https://eu.posthog.com',
    defaults: '2026-01-30',
    capture_exceptions: true,
    debug: process.env.NODE_ENV === 'development',
  });
  // A user who previously withdrew consent left PostHog's own opt-out flag in
  // this browser; granting again must clear it or events stay suppressed.
  if (posthog.has_opted_out_capturing()) posthog.opt_in_capturing();
}

/** Withdrawal (Art. 7 Abs. 3 DSGVO): stop capturing and drop identifiers. */
export function stopAnalytics(): void {
  if (!posthog.__loaded) return;
  posthog.opt_out_capturing();
  posthog.reset();
}
