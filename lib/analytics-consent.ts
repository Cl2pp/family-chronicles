/**
 * Analytics (PostHog) consent — DSGVO / TDDDG.
 *
 * The user's choice is stored in a plain cookie (not localStorage) so the
 * SERVER can honor it too: `lib/posthog-server.ts` drops events for users
 * without a granted-consent cookie. Storing the decision itself is technically
 * necessary (§ 25 Abs. 2 TDDDG); PostHog's own cookies are only ever set after
 * opt-in (see lib/posthog-client.ts).
 */
export const ANALYTICS_CONSENT_COOKIE = 'fw_analytics_consent';
export type AnalyticsConsent = 'granted' | 'denied';

/**
 * Fired on `window` when consent is granted mid-session, so components that
 * mounted before analytics started (e.g. PostHogIdentify) can catch up.
 */
export const ANALYTICS_CONSENT_GRANTED_EVENT = 'fw:analytics-consent-granted';

/** Fired on every consent write — drives `useAnalyticsConsent` re-renders. */
export const ANALYTICS_CONSENT_CHANGED_EVENT = 'fw:analytics-consent-changed';

/** Re-ask after a year — consent should not be older than the product. */
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** Read the stored choice in the browser; null = not decided yet. */
export function readAnalyticsConsent(): AnalyticsConsent | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(
    new RegExp(`(?:^|; )${ANALYTICS_CONSENT_COOKIE}=(granted|denied)`),
  );
  return match ? (match[1] as AnalyticsConsent) : null;
}

export function writeAnalyticsConsent(value: AnalyticsConsent): void {
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${ANALYTICS_CONSENT_COOKIE}=${value}; Max-Age=${MAX_AGE_SECONDS}; Path=/; SameSite=Lax${secure}`;
  window.dispatchEvent(new Event(ANALYTICS_CONSENT_CHANGED_EVENT));
  if (value === 'granted') {
    window.dispatchEvent(new Event(ANALYTICS_CONSENT_GRANTED_EVENT));
  }
}

