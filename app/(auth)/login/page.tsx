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
  TextInput,
  Title,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { authClient } from '@/lib/auth-client';
import { GoogleAuthButton } from '@/components/google-auth-button';
import { useI18n } from '@/lib/i18n/client';
import posthog from 'posthog-js';

function LoginForm() {
  const router = useRouter();
  const { t } = useI18n();
  const params = useSearchParams();
  const next = params.get('next') || '/chat';
  // OAuth callback failures redirect here with ?error=… (see onAPIError in
  // lib/auth.ts). account_not_linked is the one users can act on themselves.
  const oauthError = params.get('error');
  const [loading, setLoading] = useState(false);

  const form = useForm({
    initialValues: { email: '', password: '' },
    validate: {
      email: (v) => (/^\S+@\S+\.\S+$/.test(v) ? null : t.auth.enterValidEmail),
      password: (v) => (v.length >= 8 ? null : t.auth.atLeast8Chars),
    },
  });

  async function handleSubmit(values: typeof form.values) {
    setLoading(true);
    const { error, data } = await authClient.signIn.email({
      email: values.email,
      password: values.password,
    });
    setLoading(false);
    if (error) {
      notifications.show({ color: 'red', message: error.message ?? t.auth.signInFailed });
      return;
    }
    // The user_signed_in event is captured server-side (lib/auth.ts hooks);
    // identify here just ties the anonymous browser session to the account.
    if (data?.user) {
      posthog.identify(data.user.id, { name: data.user.name, email: data.user.email });
    }
    router.push(next);
    router.refresh();
  }

  return (
    <Paper withBorder p="xl" radius="md">
      <Title order={2} mb="lg">
        {t.auth.welcomeBack}
      </Title>
      {oauthError && (
        <Alert color="yellow" mb="md">
          {oauthError === 'account_not_linked'
            ? t.auth.accountNotLinked
            : t.auth.signInFailed}
        </Alert>
      )}
      <form onSubmit={form.onSubmit(handleSubmit)}>
        <Stack>
          <TextInput
            label={t.auth.email}
            placeholder={t.auth.emailPlaceholder}
            {...form.getInputProps('email')}
          />
          <PasswordInput label={t.auth.password} {...form.getInputProps('password')} />
          <Text size="sm" ta="right" mt={-8}>
            <Anchor href="/forgot-password" size="sm">
              {t.auth.forgotPassword}
            </Anchor>
          </Text>
          <Button type="submit" loading={loading} fullWidth>
            {t.auth.signIn}
          </Button>
          <GoogleAuthButton next={next} />
        </Stack>
      </form>

      <Text size="sm" mt="lg" ta="center">
        {t.auth.noAccountYet}{' '}
        <Anchor href={`/signup?next=${encodeURIComponent(next)}`}>{t.auth.createOne}</Anchor>
      </Text>
    </Paper>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
