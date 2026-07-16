import { Box, Container, Divider, Group, Anchor } from '@mantine/core';
import { LandingTopbar } from '../landing-topbar';

/**
 * Public chrome for the legal pages (Impressum, Datenschutz). Mirrors the
 * marketing page's top bar and footer so the pages feel part of the site, but
 * — unlike the (auth) layout — it never redirects: these must be reachable by
 * anyone, signed in or not, to satisfy the German Impressumspflicht.
 *
 * The content is German-only (Impressum/Datenschutz are German legal
 * artifacts), so we pin `lang="de"` on the article regardless of the UI locale.
 */
export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <Box bg="white" mih="100dvh">
      <Container size="lg" py="md">
        <LandingTopbar />
      </Container>

      <Container size="sm" py={{ base: 32, sm: 56 }} lang="de">
        {children}
      </Container>

      <Container size="lg" py="xl">
        <Divider mb="md" />
        <Group justify="space-between" wrap="wrap" gap="sm">
          <Anchor href="/" c="slate.5" fz="sm" underline="hover">
            Familienwerk
          </Anchor>
          <Group gap="md" wrap="wrap">
            <Anchor href="/impressum" c="slate.5" fz="sm" underline="hover">
              Impressum
            </Anchor>
            <Anchor href="/datenschutz" c="slate.5" fz="sm" underline="hover">
              Datenschutz
            </Anchor>
          </Group>
        </Group>
      </Container>
    </Box>
  );
}
