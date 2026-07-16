import { cookies } from 'next/headers';
import { and, eq } from 'drizzle-orm';
import { Box, Card, Group, Stack, Text, Title } from '@mantine/core';
import { db } from '@/db';
import { account } from '@/db/schema';
import { requireUser } from '@/lib/session';
import { presignGet } from '@/lib/s3';
import { imageTypeForKey } from '@/lib/uploads';
import { listMembers, resolveActiveChronicle } from '@/lib/chronicles';
import { canManage, type AccessRole } from '@/lib/permissions';
import { getI18n } from '@/lib/i18n/server';
import { LOCALE_BCP47 } from '@/lib/i18n/config';
import { BooksLinkCard } from './books-link-card';
import { ChangePasswordForm } from './change-password-form';
import { ChroniclesCard } from './chronicles-card';
import { InstallCard } from './install-card';
import { LanguageCard } from './language-card';
import { ProfileCard } from './profile-card';
import { SettingsTabs } from './settings-tabs';
import pkg from '@/package.json';

export default async function SettingsPage() {
  const user = await requireUser();
  const { locale, t } = await getI18n();
  const activeCookie = (await cookies()).get('activeChronicleId')?.value;

  const [{ chronicles, active }, avatarUrl, credential] = await Promise.all([
    resolveActiveChronicle(user.id, activeCookie),
    user.image ? presignGet(user.image, imageTypeForKey(user.image)) : null,
    db.query.account.findFirst({
      where: and(eq(account.userId, user.id), eq(account.providerId, 'credential')),
      columns: { id: true },
    }),
  ]);

  // For owners, the 'family'-mode warning needs to know how many member accounts
  // have no person in the tree (they would only see their own stories).
  const unlinkedCounts = new Map<string, number>();
  await Promise.all(
    chronicles
      .filter((f) => canManage(f.role as AccessRole))
      .map(async (f) => {
        const members = await listMembers(f.id);
        // Unlinked owners aren't affected (owners read everything), so they
        // don't belong in the "will only see their own stories" warning.
        unlinkedCounts.set(
          f.id,
          members.filter((m) => m.personId === null && m.role !== 'owner').length,
        );
      }),
  );

  const rows = chronicles.map((f) => ({
    id: f.id,
    name: f.name,
    description: f.description,
    styleGuide: f.styleGuide,
    storyLanguage: f.storyLanguage,
    storyAccess: f.storyAccess,
    unlinkedMemberCount: unlinkedCounts.get(f.id) ?? 0,
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

      <SettingsTabs
        account={
          <Stack gap="lg">
            <ProfileCard name={user.name} email={user.email} avatarUrl={avatarUrl} />

            <Card withBorder radius="md" p="lg">
              <Title order={3} mb="md">
                {t.account.changePassword}
              </Title>
              <ChangePasswordForm hasPassword={!!credential} />
            </Card>
          </Stack>
        }
        chronicles={
          <Box>
            <Text size="sm" c="dimmed" mb="md">
              {t.settings.chroniclesHint}
            </Text>
            <ChroniclesCard chronicles={rows} activeId={active?.id ?? null} />
          </Box>
        }
        app={
          <Stack gap="lg">
            <BooksLinkCard />

            <Box>
              <Title order={3} mb="xs">
                {t.settings.languageTitle}
              </Title>
              <LanguageCard />
            </Box>

            <Box>
              <Title order={3} mb="xs">
                {t.settings.aboutTitle}
              </Title>
              <Card withBorder radius="md" p="lg">
                <Group justify="space-between" align="flex-start">
                  <Stack gap={2}>
                    <Text fw={600}>Familienwerk</Text>
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

            <InstallCard />
          </Stack>
        }
      />
    </Box>
  );
}
