'use client';

import { useSyncExternalStore } from 'react';
import {
  ANALYTICS_CONSENT_CHANGED_EVENT,
  readAnalyticsConsent,
  type AnalyticsConsent,
} from '@/lib/analytics-consent';

// Split from lib/analytics-consent.ts: that module is also imported by server
// code (lib/posthog-server.ts), which must not pull in React hooks.

function subscribeConsent(onChange: () => void): () => void {
  window.addEventListener(ANALYTICS_CONSENT_CHANGED_EVENT, onChange);
  return () => window.removeEventListener(ANALYTICS_CONSENT_CHANGED_EVENT, onChange);
}

/**
 * The stored consent as reactive state. `'ssr'` while server-rendering /
 * hydrating (document.cookie doesn't exist there) — treat it as "don't show
 * consent UI yet".
 */
export function useAnalyticsConsent(): AnalyticsConsent | null | 'ssr' {
  return useSyncExternalStore(subscribeConsent, readAnalyticsConsent, () => 'ssr' as const);
}
