import { and, eq } from 'drizzle-orm';
import { Anchor, Box, Card, Text, Title } from '@mantine/core';
import { db } from '@/db';
import { account } from '@/db/schema';
import { requireUser } from '@/lib/session';
import { presignGet } from '@/lib/s3';
import { getI18n } from '@/lib/i18n/server';
import { ProfileCard } from './profile-card';
import { ChangePasswordForm } from './change-password-form';

export default async function AccountPage() {
  const user = await requireUser();
  const { t } = await getI18n();
  const avatarUrl = user.image ? await presignGet(user.image) : null;
  const credential = await db.query.account.findFirst({
    where: and(eq(account.userId, user.id), eq(account.providerId, 'credential')),
    columns: { id: true },
  });

  return (
    <Box p="lg" maw={640} mx="auto">
      <Title order={1} mb="lg">
        {t.account.title}
      </Title>
      <ProfileCard name={user.name} email={user.email} avatarUrl={avatarUrl} />

      <Card withBorder radius="md" p="lg" mt="lg">
        <Title order={3} mb="md">
          {t.account.changePassword}
        </Title>
        <ChangePasswordForm hasPassword={!!credential} />
      </Card>

      <Text size="sm" c="dimmed" mt="lg">
        {t.account.settingsHintPrefix}{' '}
        <Anchor component="a" href="/settings" size="sm">
          {t.account.settingsHintLink}
        </Anchor>
        .
      </Text>
    </Box>
  );
}
