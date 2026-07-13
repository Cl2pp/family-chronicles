'use client';

import { useEffect } from 'react';

/** Registers the service worker in production (enables install + offline). */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (!('serviceWorker' in navigator)) return;
    const register = () => {
      // updateViaCache: 'none' — never serve sw.js from the HTTP cache, so a
      // redeployed worker is picked up on the next check, not after max-age.
      navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {});
    };
    // Waiting for 'load' keeps registration off the critical path, but the event
    // may already have fired by the time this effect mounts (fast cached loads) —
    // registering then would silently never happen.
    if (document.readyState === 'complete') {
      register();
    } else {
      window.addEventListener('load', register, { once: true });
    }

    // PWAs are resumed far more often than they are re-navigated; check for a
    // new worker whenever the app returns to the foreground.
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      navigator.serviceWorker
        .getRegistration()
        .then((reg) => reg?.update())
        .catch(() => {});
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      window.removeEventListener('load', register);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return null;
}
