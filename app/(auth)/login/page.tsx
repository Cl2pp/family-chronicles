'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Anchor,
  Button,
  Divider,
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

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') || '/chat';
  const [loading, setLoading] = useState(false);

  const form = useForm({
    initialValues: { email: '', password: '' },
    validate: {
      email: (v) => (/^\S+@\S+\.\S+$/.test(v) ? null : 'Enter a valid email'),
      password: (v) => (v.length >= 8 ? null : 'At least 8 characters'),
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
      notifications.show({ color: 'red', message: error.message ?? 'Sign in failed' });
      return;
    }
    router.push(next);
    router.refresh();
  }

  async function sendMagicLink() {
    if (!/^\S+@\S+\.\S+$/.test(form.values.email)) {
      form.setFieldError('email', 'Enter your email first');
      return;
    }
    const { error } = await authClient.signIn.magicLink({
      email: form.values.email,
      callbackURL: next,
    });
    notifications.show(
      error
        ? { color: 'red', message: error.message ?? 'Could not send link' }
        : { message: 'Magic link sent. In development it is printed to the server console.' },
    );
  }

  return (
    <Paper withBorder p="xl" radius="md">
      <Title order={2} mb="lg">
        Welcome back
      </Title>
      <form onSubmit={form.onSubmit(handleSubmit)}>
        <Stack>
          <TextInput
            label="Email"
            placeholder="you@example.com"
            {...form.getInputProps('email')}
          />
          <PasswordInput label="Password" {...form.getInputProps('password')} />
          <Button type="submit" loading={loading} fullWidth>
            Sign in
          </Button>
        </Stack>
      </form>

      <Divider label="or" my="lg" />
      <Button variant="default" fullWidth onClick={sendMagicLink}>
        Email me a magic link
      </Button>

      <Text size="sm" mt="lg" ta="center">
        No account yet?{' '}
        <Anchor href={`/signup?next=${encodeURIComponent(next)}`}>Create one</Anchor>
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
