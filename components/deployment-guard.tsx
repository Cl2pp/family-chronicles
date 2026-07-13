'use client';

import { useEffect, useRef } from 'react';
import { notifications } from '@mantine/notifications';
import { useI18n } from '@/lib/i18n/client';

// Recovers from deployment skew: a PWA client whose bundle predates the current
// deployment calls Server Actions whose IDs no longer exist. Next answers those
// with a 404 + this header (and every action call site catches errors locally,
// so observing responses here is the one central place to detect it).
const ACTION_NOT_FOUND_HEADER = 'x-nextjs-action-not-found';
const RELOADED_AT_KEY = 'fc-skew-reloaded-at';
const RELOAD_COOLDOWN_MS = 60_000;
const VERSION_CHECK_MIN_INTERVAL_MS = 60_000;

function reloadOncePerCooldown(): void {
  try {
    const last = Number(sessionStorage.getItem(RELOADED_AT_KEY) ?? 0);
    if (Date.now() - last < RELOAD_COOLDOWN_MS) return; // don't reload-loop
    sessionStorage.setItem(RELOADED_AT_KEY, String(Date.now()));
  } catch {
    // sessionStorage unavailable — still reload, just without the loop guard.
  }
  window.location.reload();
}

/**
 * Client-side half of version-skew protection (server half: `deploymentId` in
 * next.config.ts). Two triggers, both ending in a hard reload:
 *  - a Server Action response says the action ID is unknown → the running
 *    bundle is stale; notify briefly, then reload
 *  - the app returns to the foreground and /api/version reports a different
 *    deployment than the one baked into this page → reload before the user
 *    interacts with a stale bundle
 */
export function DeploymentGuard() {
  const { t } = useI18n();
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;

    let staleHandled = false;
    const onStaleAction = () => {
      if (staleHandled) return;
      staleHandled = true;
      notifications.show({ message: tRef.current.common.appUpdatedReloading, color: 'blue' });
      // Give the notification a beat to render before the reload.
      window.setTimeout(reloadOncePerCooldown, 1500);
    };

    // Observe (don't alter) every fetch response; Server Action POSTs go
    // through window.fetch, so this sees skew failures even though the call
    // sites catch the thrown error themselves.
    const originalFetch = window.fetch;
    const patchedFetch: typeof window.fetch = function (input, init) {
      const result = originalFetch.call(window, input, init);
      result
        .then((res) => {
          if (res.headers.get(ACTION_NOT_FOUND_HEADER) === '1') onStaleAction();
        })
        .catch(() => {});
      return result;
    };
    window.fetch = patchedFetch;

    // Turbopack rewrites this to globalThis.NEXT_DEPLOYMENT_ID, which Next
    // populates before hydration from the server-stamped data-dpl-id attribute
    // (the attribute itself is removed again, so the DOM can't be read instead).
    // `false` (not configured, e.g. local builds) disables the check.
    const ownDeploymentId = process.env.NEXT_DEPLOYMENT_ID;
    let lastCheck = 0;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (!ownDeploymentId || !navigator.onLine) return;
      if (Date.now() - lastCheck < VERSION_CHECK_MIN_INTERVAL_MS) return;
      lastCheck = Date.now();
      fetch('/api/version', { cache: 'no-store' })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { deploymentId?: string | null } | null) => {
          if (data?.deploymentId && data.deploymentId !== ownDeploymentId) {
            reloadOncePerCooldown();
          }
        })
        .catch(() => {});
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      if (window.fetch === patchedFetch) window.fetch = originalFetch;
    };
  }, []);

  return null;
}
