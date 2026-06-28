'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * While `active` is true, re-fetch the current server component tree on an
 * interval — used to surface story status changes (processing → ready) without
 * a manual reload.
 */
export function AutoRefresh({ active, intervalMs = 4000 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs, router]);
  return null;
}
