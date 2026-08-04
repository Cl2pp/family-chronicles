import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { resolveActiveChronicle } from '@/lib/chronicles';

/**
 * The one place that reads the `activeChronicleId` cookie server-side, so every
 * page/action agrees on which chronicle is "current" — was previously duplicated
 * across 8 files as `(await cookies()).get('activeChronicleId')?.value` followed
 * by `resolveActiveChronicle(userId, v)`. The cookie name is a stable contract
 * (existing sessions, and the client-side switcher that writes it, depend on it).
 */
export async function getActiveChronicle(userId: string) {
  const cookieValue = (await cookies()).get('activeChronicleId')?.value;
  return resolveActiveChronicle(userId, cookieValue);
}

/**
 * Same resolution, for pages that can't render without an active chronicle — a
 * brand-new user has none yet, so send them to create their first instead of
 * rendering a broken page.
 */
export async function requireActiveChronicle(userId: string) {
  const { active } = await getActiveChronicle(userId);
  if (!active) redirect('/chronicle/new');
  return active;
}
