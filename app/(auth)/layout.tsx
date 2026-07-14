import { redirect } from 'next/navigation';
import { Center, Container } from '@mantine/core';
import { getSession } from '@/lib/session';

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  // Already signed in? Login/signup forms would only invite a pointless
  // re-login (the pinned-PWA "logged out on every reopen" trap).
  const session = await getSession();
  if (session?.user) redirect('/chat');

  return (
    <Center mih="100dvh">
      <Container size={420} w="100%" py="xl">
        {children}
      </Container>
    </Center>
  );
}
