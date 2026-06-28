import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';

/** Current session (or null) from the request cookies. */
export async function getSession() {
  return auth.api.getSession({ headers: await headers() });
}

/** Require a logged-in user; redirect to /login otherwise. */
export async function requireUser() {
  const session = await getSession();
  if (!session?.user) redirect('/login');
  return session.user;
}
