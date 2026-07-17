import { cookies } from 'next/headers';
import { PostHog } from 'posthog-node';
import { env } from '@/lib/env';
import { ANALYTICS_CONSENT_COOKIE } from '@/lib/analytics-consent';

let posthogClient: PostHog | null = null;

function getClient(): PostHog {
  if (!posthogClient) {
    // Without a key the client disables itself and every capture is a no-op.
    posthogClient = new PostHog(env.NEXT_PUBLIC_POSTHOG_KEY ?? '', {
      host: env.NEXT_PUBLIC_POSTHOG_HOST,
      // Send each event straight away — this is a long-running server, and an
      // unflushed batch would be lost on redeploy.
      flushAt: 1,
      flushInterval: 0,
    });
  }
  return posthogClient;
}

/**
 * Fire-and-forget server-side analytics. Must never throw or add latency to
 * the user action that emits it: `capture` only enqueues (with flushAt: 1 the
 * client kicks off its own error-swallowed background flush), so nothing here
 * awaits the network — do NOT add a `flush()` to the call path.
 *
 * Consent-gated (Art. 6 Abs. 1 lit. a DSGVO): an event is only captured when
 * the request carries the granted-consent cookie set by the consent banner.
 * Outside a request scope there is no consent signal, so the event is dropped.
 */
export function captureServerEvent(
  distinctId: string,
  event: string,
  properties?: Record<string, unknown>,
): void {
  void (async () => {
    let consent: string | undefined;
    try {
      consent = (await cookies()).get(ANALYTICS_CONSENT_COOKIE)?.value;
    } catch {
      return; // no request scope → treat as "no consent"
    }
    if (consent !== 'granted') return;
    try {
      getClient().capture({ distinctId, event, properties });
    } catch (err) {
      console.error(`PostHog capture failed for ${event}:`, err);
    }
  })();
}
