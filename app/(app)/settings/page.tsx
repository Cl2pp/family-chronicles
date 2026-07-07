import { cookies } from 'next/headers';
import { Anchor, Box, Card, Group, Stack, Text, Title } from '@mantine/core';
import { requireUser } from '@/lib/session';
import { getChronicle, resolveActiveChronicle } from '@/lib/chronicles';
import { canManage, type AccessRole } from '@/lib/permissions';
import { getI18n } from '@/lib/i18n/server';
import { LOCALE_BCP47 } from '@/lib/i18n/config';
import { ChroniclesCard } from './chronicles-card';
import { ChronicleSettingsCard } from './chronicle-settings-card';
import { LanguageCard } from './language-card';
import pkg from '@/package.json';

export default async function SettingsPage() {
  const user = await requireUser();
  const { locale, t } = await getI18n();
  const activeCookie = (await cookies()).get('activeChronicleId')?.value;
  const { chronicles, active } = await resolveActiveChronicle(user.id, activeCookie);
  const fullChronicle = active ? await getChronicle(active.id) : undefined;

  const rows = chronicles.map((f) => ({
    id: f.id,
    name: f.name,
    description: f.description,
    role: f.role as AccessRole,
    createdLabel: f.createdAt.toLocaleDateString(LOCALE_BCP47[locale], {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }),
  }));

  return (
    <Box p="lg" maw={760} mx="auto">
      <Title order={1} mb="lg">
        {t.settings.title}
      </Title>

      <Stack gap="lg">
        <Box>
          <Title order={3} mb="xs">
            {t.settings.languageTitle}
          </Title>
          <LanguageCard />
        </Box>

        <Box>
          <Title order={3} mb="xs">
            {t.settings.myChroniclesTitle}
          </Title>
          <Text size="sm" c="dimmed" mb="md">
            {t.settings.myChroniclesHint}
          </Text>
          <ChroniclesCard chronicles={rows} activeId={active?.id ?? null} />
        </Box>

        {active && fullChronicle && (
          <Box>
            <Title order={3} mb="xs">
              {t.settings.chronicleSettingsTitle}
            </Title>
            <ChronicleSettingsCard
              chronicleId={active.id}
              name={fullChronicle.name}
              description={fullChronicle.description ?? ''}
              styleGuide={fullChronicle.styleGuide ?? ''}
              storyLanguage={fullChronicle.storyLanguage}
              canManage={canManage(active.role as AccessRole)}
            />
          </Box>
        )}

        <Box>
          <Title order={3} mb="xs">
            {t.settings.aboutTitle}
          </Title>
          <Card withBorder radius="md" p="lg">
            <Group justify="space-between" align="flex-start">
              <Stack gap={2}>
                <Text fw={600}>Family Chronicle</Text>
                <Text size="sm" c="dimmed">
                  {t.settings.aboutDescription}
                </Text>
              </Stack>
              <Text size="sm" c="dimmed">
                v{pkg.version}
              </Text>
            </Group>
          </Card>
        </Box>

        <Text size="sm" c="dimmed">
          {t.settings.accountHintPrefix}{' '}
          <Anchor component="a" href="/account" size="sm">
            {t.settings.accountHintLink}
          </Anchor>
          .
        </Text>
      </Stack>
    </Box>
  );
}
