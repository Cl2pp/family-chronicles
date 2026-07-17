'use client';

import { useEffect } from 'react';
import posthog from 'posthog-js';
import { ANALYTICS_CONSENT_GRANTED_EVENT } from '@/lib/analytics-consent';

export function PostHogIdentify({
  userId,
  name,
  email,
}: {
  userId: string;
  name: string;
  email: string;
}) {
  useEffect(() => {
    // Only after consent-gated init — and again if consent is granted after
    // this component already mounted (the banner fires the window event).
    const identify = () => {
      if (posthog.__loaded) posthog.identify(userId, { name, email });
    };
    identify();
    window.addEventListener(ANALYTICS_CONSENT_GRANTED_EVENT, identify);
    return () => window.removeEventListener(ANALYTICS_CONSENT_GRANTED_EVENT, identify);
  }, [userId, name, email]);
  return null;
}
