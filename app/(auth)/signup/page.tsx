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

function SignupForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') || '/dashboard';
  const [loading, setLoading] = useState(false);

  const form = useForm({
    initialValues: { name: '', email: '', password: '' },
    validate: {
      name: (v) => (v.trim().length >= 2 ? null : 'Tell us your name'),
      email: (v) => (/^\S+@\S+\.\S+$/.test(v) ? null : 'Enter a valid email'),
      password: (v) => (v.length >= 8 ? null : 'At least 8 characters'),
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
      notifications.show({ color: 'red', message: error.message ?? 'Sign up failed' });
      return;
    }
    router.push(next);
    router.refresh();
  }

  return (
    <Paper withBorder p="xl" radius="md">
      <Title order={2} mb="lg">
        Create your account
      </Title>
      <form onSubmit={form.onSubmit(handleSubmit)}>
        <Stack>
          <TextInput label="Name" placeholder="Maria Schmidt" {...form.getInputProps('name')} />
          <TextInput
            label="Email"
            placeholder="you@example.com"
            {...form.getInputProps('email')}
          />
          <PasswordInput label="Password" {...form.getInputProps('password')} />
          <Button type="submit" loading={loading} fullWidth>
            Create account
          </Button>
        </Stack>
      </form>

      <Text size="sm" mt="lg" ta="center">
        Already have an account?{' '}
        <Anchor href={`/login?next=${encodeURIComponent(next)}`}>Sign in</Anchor>
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
