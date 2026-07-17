import { redirect } from 'next/navigation';
import { Anchor, Center, Container, Group } from '@mantine/core';
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
        {/* Art. 13 DSGVO: the privacy notice must be reachable where data is collected. */}
        <Group justify="center" gap="lg" mt="md">
          <Anchor href="/impressum" fz="xs" c="dimmed">
            Impressum
          </Anchor>
          <Anchor href="/datenschutz" fz="xs" c="dimmed">
            Datenschutz
          </Anchor>
        </Group>
      </Container>
    </Center>
  );
}
