import { redirect } from 'next/navigation';
import {
  Container,
  Title,
  Text,
  Button,
  Group,
  Stack,
  SimpleGrid,
  Card,
  Box,
  Badge,
  ThemeIcon,
  Divider,
} from '@mantine/core';
import { getI18n } from '@/lib/i18n/server';
import { getSession } from '@/lib/session';
import { LandingTopbar } from './landing-topbar';
import {
  PipelineGraphic,
  TimelineGraphic,
  TreeGraphic,
  BookGraphic,
  MicIcon,
  TimelineIcon,
  TreeIcon,
  BookIcon,
  LockIcon,
  QuoteIcon,
} from './landing-graphics';

export default async function Home() {
  // The PWA's start_url is "/" — a signed-in user cold-starting the pinned app
  // must land in the app, not on the marketing page with a sign-in button.
  const session = await getSession();
  if (session?.user) redirect('/chat');

  const { t } = await getI18n();
  const h = t.home;

  const steps = [
    { n: '1', title: h.step1Title, text: h.step1Text },
    { n: '2', title: h.step2Title, text: h.step2Text },
    { n: '3', title: h.step3Title, text: h.step3Text },
  ];

  const showcases = [
    { title: h.featureTimelineTitle, text: h.featureTimelineText, graphic: <TimelineGraphic /> },
    { title: h.featureTreeTitle, text: h.featureTreeText, graphic: <TreeGraphic /> },
    { title: h.featureBookTitle, text: h.featureBookText, graphic: <BookGraphic /> },
  ];

  const features = [
    { icon: <MicIcon />, title: h.featureVoiceTitle, text: h.featureVoiceText },
    { icon: <QuoteIcon />, title: h.featureMemoirTitle, text: h.featureMemoirText },
    { icon: <TimelineIcon />, title: h.featureTimelineTitle, text: h.featureTimelineText },
    { icon: <TreeIcon />, title: h.featureTreeTitle, text: h.featureTreeText },
    { icon: <BookIcon />, title: h.featureBookTitle, text: h.featureBookText },
    { icon: <LockIcon />, title: h.featurePrivateTitle, text: h.featurePrivateText },
  ];

  return (
    <Box bg="white" mih="100dvh">
      <Container size="lg" py="md">
        <LandingTopbar />
      </Container>

      {/* ── Hero ─────────────────────────────────────────────── */}
      <Box
        style={{
          background:
            'linear-gradient(180deg, var(--mantine-color-brand-0) 0%, var(--mantine-color-white) 100%)',
        }}
      >
        <Container size="lg" py={{ base: 40, sm: 72 }}>
          <SimpleGrid cols={{ base: 1, md: 2 }} spacing={48} verticalSpacing={40}>
            <Stack gap="lg" justify="center">
              <Badge
                variant="light"
                color="brand"
                radius="sm"
                size="lg"
                w="fit-content"
                tt="none"
                fw={600}
              >
                {h.eyebrow}
              </Badge>
              <Title order={1} fz={{ base: 34, sm: 48 }} lh={1.1} c="slate.9">
                {h.heroTitle}
              </Title>
              <Text fz={{ base: 'md', sm: 'lg' }} c="slate.6" maw={520}>
                {h.heroSubtitle}
              </Text>
              <Group gap="sm" mt="xs">
                <Button component="a" href="/signup" size="md">
                  {h.ctaPrimary}
                </Button>
                <Button component="a" href="/login" size="md" variant="default">
                  {h.ctaSecondary}
                </Button>
              </Group>
              <Text size="sm" c="slate.5" mt={4}>
                {h.footerNote}
              </Text>
            </Stack>

            <Box style={{ alignSelf: 'center', width: '100%' }}>
              <PipelineGraphic />
            </Box>
          </SimpleGrid>
        </Container>
      </Box>

      {/* ── How it works ─────────────────────────────────────── */}
      <Container size="lg" py={{ base: 48, sm: 80 }}>
        <Stack gap={8} align="center" ta="center" mb={40}>
          <Title order={2} fz={{ base: 26, sm: 34 }} c="slate.9">
            {h.stepsTitle}
          </Title>
          <Text c="slate.6" fz="lg" maw={560}>
            {h.stepsSubtitle}
          </Text>
        </Stack>
        <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="xl">
          {steps.map((s) => (
            <Card key={s.n} withBorder radius="lg" p="xl" bg="white">
              <ThemeIcon size={44} radius="xl" variant="light" color="brand" fw={700}>
                <Text fw={700} fz="lg" c="brand.7">
                  {s.n}
                </Text>
              </ThemeIcon>
              <Title order={3} fz="xl" mt="md" c="slate.9">
                {s.title}
              </Title>
              <Text c="slate.6" mt="xs" fz="sm" lh={1.6}>
                {s.text}
              </Text>
            </Card>
          ))}
        </SimpleGrid>
      </Container>

      {/* ── Showcase (with generated graphics) ───────────────── */}
      <Box bg="slate.0">
        <Container size="lg" py={{ base: 48, sm: 80 }}>
          <Stack gap={64}>
            {showcases.map((sc, i) => (
              <SimpleGrid key={sc.title} cols={{ base: 1, md: 2 }} spacing={48} verticalSpacing={24}>
                <Box style={{ order: i % 2 === 1 ? 2 : 1 }}>
                  <Card withBorder radius="lg" p="xl" bg="white" h="100%">
                    <Box maw={340} mx="auto" w="100%">
                      {sc.graphic}
                    </Box>
                  </Card>
                </Box>
                <Stack gap="sm" justify="center" style={{ order: i % 2 === 1 ? 1 : 2 }}>
                  <Title order={3} fz={{ base: 22, sm: 28 }} c="slate.9">
                    {sc.title}
                  </Title>
                  <Text c="slate.6" fz="md" lh={1.7} maw={460}>
                    {sc.text}
                  </Text>
                </Stack>
              </SimpleGrid>
            ))}
          </Stack>
        </Container>
      </Box>

      {/* ── Feature grid ─────────────────────────────────────── */}
      <Container size="lg" py={{ base: 48, sm: 80 }}>
        <Title order={2} fz={{ base: 26, sm: 34 }} c="slate.9" ta="center" mb={40}>
          {h.featuresTitle}
        </Title>
        <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="lg">
          {features.map((f) => (
            <Card key={f.title} withBorder radius="lg" p="lg" bg="white">
              <ThemeIcon size={42} radius="md" variant="light" color="brand">
                {f.icon}
              </ThemeIcon>
              <Title order={3} fz="md" mt="md" c="slate.9">
                {f.title}
              </Title>
              <Text c="slate.6" mt={6} fz="sm" lh={1.6}>
                {f.text}
              </Text>
            </Card>
          ))}
        </SimpleGrid>
      </Container>

      {/* ── Closing CTA ──────────────────────────────────────── */}
      <Box
        style={{
          background:
            'linear-gradient(135deg, var(--mantine-color-brand-7) 0%, var(--mantine-color-brand-9) 100%)',
        }}
      >
        <Container size="md" py={{ base: 56, sm: 88 }}>
          <Stack gap="lg" align="center" ta="center">
            <Title order={2} fz={{ base: 26, sm: 36 }} c="white" maw={620}>
              {h.closingTitle}
            </Title>
            <Text c="brand.1" fz="lg" maw={520}>
              {h.closingText}
            </Text>
            <Button component="a" href="/signup" size="lg" color="white" c="brand.8" mt="xs">
              {h.closingCta}
            </Button>
          </Stack>
        </Container>
      </Box>

      <Container size="lg" py="xl">
        <Divider mb="md" />
        <Group justify="space-between" wrap="wrap">
          <Text size="sm" c="slate.5">
            Familienwerk
          </Text>
          <Text size="sm" c="slate.5">
            {h.footerNote}
          </Text>
        </Group>
      </Container>
    </Box>
  );
}
