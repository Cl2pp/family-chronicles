import posthog from 'posthog-js';
import {
  ANALYTICS_CONSENT_GRANTED_EVENT,
  readAnalyticsConsent,
} from '@/lib/analytics-consent';

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
  // Only now — with PostHog actually running — tell already-mounted components
  // (PostHogIdentify) to catch up. Dispatching from writeAnalyticsConsent would
  // fire the listeners synchronously BEFORE init, and the identify would no-op.
  window.dispatchEvent(new Event(ANALYTICS_CONSENT_GRANTED_EVENT));
}

/** Withdrawal (Art. 7 Abs. 3 DSGVO): stop capturing and drop identifiers. */
export function stopAnalytics(): void {
  if (!posthog.__loaded) return;
  posthog.opt_out_capturing();
  posthog.reset();
  // reset() rotates the id but leaves PostHog's storage behind; after a
  // withdrawal that storage has no legal basis (§ 25 TDDDG) — expunge it.
  try {
    for (const k of Object.keys(window.localStorage)) {
      if (k.startsWith('ph_')) window.localStorage.removeItem(k);
    }
    for (const part of document.cookie.split('; ')) {
      const name = part.split('=')[0];
      if (name.startsWith('ph_')) {
        document.cookie = `${name}=; Max-Age=0; Path=/`;
      }
    }
  } catch {
    // Storage access can throw (privacy modes) — the opt-out above still holds.
  }
}
