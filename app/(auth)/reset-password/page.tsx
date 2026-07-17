'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Alert,
  Anchor,
  Button,
  Paper,
  PasswordInput,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { authClient } from '@/lib/auth-client';
import { useI18n } from '@/lib/i18n/client';

function ResetPasswordForm() {
  const router = useRouter();
  const { t } = useI18n();
  // The email link goes through better-auth's callback endpoint, which lands
  // here with ?token=… (valid) or ?error=INVALID_TOKEN (expired/used).
  const params = useSearchParams();
  const token = params.get('token');
  const [loading, setLoading] = useState(false);
  // The callback only validates the token at click time; it can still expire
  // or be consumed (second device, double submit) before the form is sent.
  const [tokenRejected, setTokenRejected] = useState(false);

  const form = useForm({
    initialValues: { password: '', confirmPassword: '' },
    validate: {
      password: (v) => (v.length >= 8 ? null : t.auth.atLeast8Chars),
      confirmPassword: (v, values) =>
        v === values.password ? null : t.auth.passwordsDoNotMatch,
    },
  });

  async function handleSubmit(values: typeof form.values) {
    if (!token) return;
    setLoading(true);
    const { error } = await authClient.resetPassword({
      newPassword: values.password,
      token,
    });
    setLoading(false);
    if (error) {
      if (error.code === 'INVALID_TOKEN') {
        setTokenRejected(true);
        return;
      }
      notifications.show({ color: 'red', message: error.message ?? t.auth.resetPasswordFailed });
      return;
    }
    notifications.show({ color: 'green', message: t.auth.passwordResetSuccess });
    router.push('/login');
  }

  return (
    <Paper withBorder p="xl" radius="md">
      <Title order={2} mb="lg">
        {t.auth.resetPasswordTitle}
      </Title>
      {token && !tokenRejected ? (
        <form onSubmit={form.onSubmit(handleSubmit)}>
          <Stack>
            <PasswordInput label={t.auth.newPassword} {...form.getInputProps('password')} />
            <PasswordInput
              label={t.auth.confirmNewPassword}
              {...form.getInputProps('confirmPassword')}
            />
            <Button type="submit" loading={loading} fullWidth>
              {t.auth.setNewPassword}
            </Button>
          </Stack>
        </form>
      ) : (
        <Stack>
          <Alert color="yellow">{t.auth.resetLinkInvalid}</Alert>
          <Button component="a" href="/forgot-password" variant="light" fullWidth>
            {t.auth.requestNewLink}
          </Button>
        </Stack>
      )}
      <Text size="sm" mt="lg" ta="center">
        <Anchor href="/login">{t.auth.backToSignIn}</Anchor>
      </Text>
    </Paper>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetPasswordForm />
    </Suspense>
  );
}
