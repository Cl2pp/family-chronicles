import { Container, Title, Text, Button, Group, Stack, Paper } from '@mantine/core';

export default function Home() {
  return (
    <Container size="sm" py={120}>
      <Stack gap="xl" align="center" ta="center">
        <Stack gap="sm">
          <Title order={1} fz={48}>
            Family Chronicle
          </Title>
          <Text c="dimmed" fz="lg" maw={520}>
            A private vault where your family&rsquo;s stories live. Write them down or just
            speak — and watch them become a shared family book, placed on a timeline,
            generation after generation.
          </Text>
        </Stack>

        <Group>
          <Button component="a" href="/login" size="md">
            Sign in
          </Button>
          <Button component="a" href="/signup" size="md" variant="default">
            Create account
          </Button>
        </Group>

        <Paper withBorder p="md" radius="md" maw={520} mt="xl">
          <Text size="sm" c="dimmed">
            Contribute by writing or by voice message. Stories are transcribed and gently
            retold in a consistent memoir voice, with photos, dates, and full credit to
            whoever shared them.
          </Text>
        </Paper>
      </Stack>
    </Container>
  );
}
