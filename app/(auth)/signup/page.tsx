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

function SignupForm() {
  const router = useRouter();
  const { t } = useI18n();
  const params = useSearchParams();
  const next = params.get('next') || '/chat';
  const [loading, setLoading] = useState(false);

  const form = useForm({
    initialValues: { name: '', email: '', password: '' },
    validate: {
      name: (v) => (v.trim().length >= 2 ? null : t.auth.tellUsYourName),
      email: (v) => (/^\S+@\S+\.\S+$/.test(v) ? null : t.auth.enterValidEmail),
      password: (v) => (v.length >= 8 ? null : t.auth.atLeast8Chars),
    },
  });

  async function handleSubmit(values: typeof form.values) {
    setLoading(true);
    const { error } = await authClient.signUp.email({
      name: values.name.trim(),
      email: values.email,
      password: values.password,
    });
    setLoading(false);
    if (error) {
      notifications.show({ color: 'red', message: error.message ?? t.auth.signUpFailed });
      return;
    }
    router.push(next);
    router.refresh();
  }

  return (
    <Paper withBorder p="xl" radius="md">
      <Title order={2} mb="lg">
        {t.auth.createYourAccount}
      </Title>
      <form onSubmit={form.onSubmit(handleSubmit)}>
        <Stack>
          <TextInput
            label={t.auth.name}
            placeholder={t.auth.namePlaceholder}
            {...form.getInputProps('name')}
          />
          <TextInput
            label={t.auth.email}
            placeholder={t.auth.emailPlaceholder}
            {...form.getInputProps('email')}
          />
          <PasswordInput label={t.auth.password} {...form.getInputProps('password')} />
          <Button type="submit" loading={loading} fullWidth>
            {t.home.createAccount}
          </Button>
        </Stack>
      </form>

      <Text size="sm" mt="lg" ta="center">
        {t.auth.alreadyHaveAccount}{' '}
        <Anchor href={`/login?next=${encodeURIComponent(next)}`}>{t.auth.signIn}</Anchor>
      </Text>
    </Paper>
  );
}

export default function SignupPage() {
  return (
    <Suspense>
      <SignupForm />
    </Suspense>
  );
}
