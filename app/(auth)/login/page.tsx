'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
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
import { useI18n } from '@/lib/i18n/client';

function LoginForm() {
  const router = useRouter();
  const { t } = useI18n();
  const params = useSearchParams();
  const next = params.get('next') || '/chat';
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
    const { error } = await authClient.signIn.email({
      email: values.email,
      password: values.password,
    });
    setLoading(false);
    if (error) {
      notifications.show({ color: 'red', message: error.message ?? t.auth.signInFailed });
      return;
    }
    router.push(next);
    router.refresh();
  }

  return (
    <Paper withBorder p="xl" radius="md">
      <Title order={2} mb="lg">
        {t.auth.welcomeBack}
      </Title>
      <form onSubmit={form.onSubmit(handleSubmit)}>
        <Stack>
          <TextInput
            label={t.auth.email}
            placeholder={t.auth.emailPlaceholder}
            {...form.getInputProps('email')}
          />
          <PasswordInput label={t.auth.password} {...form.getInputProps('password')} />
          <Button type="submit" loading={loading} fullWidth>
            {t.auth.signIn}
          </Button>
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
