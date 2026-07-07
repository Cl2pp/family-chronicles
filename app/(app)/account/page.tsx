import { and, eq } from 'drizzle-orm';
import { Anchor, Box, Card, Text, Title } from '@mantine/core';
import { db } from '@/db';
import { account } from '@/db/schema';
import { requireUser } from '@/lib/session';
import { presignGet } from '@/lib/s3';
import { ProfileCard } from './profile-card';
import { ChangePasswordForm } from './change-password-form';

export default async function AccountPage() {
  const user = await requireUser();
  const avatarUrl = user.image ? await presignGet(user.image) : null;
  const credential = await db.query.account.findFirst({
    where: and(eq(account.userId, user.id), eq(account.providerId, 'credential')),
    columns: { id: true },
  });

  return (
    <Box p="lg" maw={640} mx="auto">
      <Title order={1} mb="lg">
        Account
      </Title>
      <ProfileCard name={user.name} email={user.email} avatarUrl={avatarUrl} />

      <Card withBorder radius="md" p="lg" mt="lg">
        <Title order={3} mb="md">
          Change password
        </Title>
        <ChangePasswordForm hasPassword={!!credential} />
      </Card>

      <Text size="sm" c="dimmed" mt="lg">
        Looking for your chronicles or app info? See{' '}
        <Anchor component="a" href="/settings" size="sm">
          App settings
        </Anchor>
        .
      </Text>
    </Box>
  );
}
