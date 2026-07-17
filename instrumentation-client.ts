import { startAnalytics } from './lib/posthog-client';

// PostHog only ever starts with stored opt-in consent (DSGVO / § 25 TDDDG).
// The consent banner (components/consent-banner.tsx) starts it the moment
// consent is granted; this call covers every later page load.
startAnalytics();
