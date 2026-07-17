import { PostHog } from 'posthog-node';
import { env } from '@/lib/env';

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
 */
export function captureServerEvent(
  distinctId: string,
  event: string,
  properties?: Record<string, unknown>,
): void {
  try {
    getClient().capture({ distinctId, event, properties });
  } catch (err) {
    console.error(`PostHog capture failed for ${event}:`, err);
  }
}
