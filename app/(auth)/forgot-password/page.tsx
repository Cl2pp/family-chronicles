'use client';

import { useState } from 'react';
import { Alert, Anchor, Button, Paper, Stack, Text, TextInput, Title } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { authClient } from '@/lib/auth-client';
import { useI18n } from '@/lib/i18n/client';

export default function ForgotPasswordPage() {
  const { t } = useI18n();
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const form = useForm({
    initialValues: { email: '' },
    validate: {
      email: (v) => (/^\S+@\S+\.\S+$/.test(v) ? null : t.auth.enterValidEmail),
    },
  });

  async function handleSubmit(values: typeof form.values) {
    setLoading(true);
    // The endpoint responds identically whether the email exists or not, so
    // the success state below is safe to show unconditionally.
    const { error } = await authClient.requestPasswordReset({
      email: values.email,
      redirectTo: '/reset-password',
    });
    setLoading(false);
    if (error) {
      notifications.show({ color: 'red', message: error.message ?? t.auth.resetPasswordFailed });
      return;
    }
    setSent(true);
  }

  return (
    <Paper withBorder p="xl" radius="md">
      <Title order={2} mb="lg">
        {t.auth.resetPasswordTitle}
      </Title>
      {sent ? (
        <Alert color="green">{t.auth.resetLinkSent}</Alert>
      ) : (
        <form onSubmit={form.onSubmit(handleSubmit)}>
          <Stack>
            <Text size="sm" c="dimmed">
              {t.auth.forgotPasswordIntro}
            </Text>
            <TextInput
              label={t.auth.email}
              placeholder={t.auth.emailPlaceholder}
              {...form.getInputProps('email')}
            />
            <Button type="submit" loading={loading} fullWidth>
              {t.auth.sendResetLink}
            </Button>
          </Stack>
        </form>
      )}
      <Text size="sm" mt="lg" ta="center">
        <Anchor href="/login">{t.auth.backToSignIn}</Anchor>
      </Text>
    </Paper>
  );
}
