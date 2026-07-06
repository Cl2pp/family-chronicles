'use client';

import { useState } from 'react';
import { Button, Group, PasswordInput, Stack, Text } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { authClient } from '@/lib/auth-client';

export function ChangePasswordForm({ hasPassword }: { hasPassword: boolean }) {
  const [pending, setPending] = useState(false);
  const form = useForm({
    initialValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
    validate: {
      currentPassword: (v) => (v ? null : 'Enter your current password'),
      newPassword: (v) => (v.length >= 8 ? null : 'At least 8 characters'),
      confirmPassword: (v, values) =>
        v === values.newPassword ? null : 'Passwords do not match',
    },
  });

  if (!hasPassword) {
    return (
      <Text c="dimmed" size="sm">
        You signed in with a magic link, so this account has no password yet.
      </Text>
    );
  }

  async function handleSubmit(values: typeof form.values) {
    setPending(true);
    try {
      const { error } = await authClient.changePassword({
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
        revokeOtherSessions: true,
      });
      if (!error) {
        notifications.show({ message: 'Password changed' });
        form.reset();
      } else if (error.code === 'INVALID_PASSWORD') {
        form.setFieldError('currentPassword', 'Current password is incorrect');
      } else if (error.code === 'PASSWORD_TOO_SHORT' || error.code === 'PASSWORD_TOO_LONG') {
        form.setFieldError('newPassword', error.message ?? 'Invalid new password');
      } else {
        notifications.show({
          color: 'red',
          message: error.message ?? 'Could not change the password',
        });
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={form.onSubmit(handleSubmit)}>
      <Stack>
        <PasswordInput
          label="Current password"
          autoComplete="current-password"
          {...form.getInputProps('currentPassword')}
        />
        <PasswordInput
          label="New password"
          autoComplete="new-password"
          {...form.getInputProps('newPassword')}
        />
        <PasswordInput
          label="Confirm new password"
          autoComplete="new-password"
          {...form.getInputProps('confirmPassword')}
        />
        <Group justify="flex-end">
          <Button type="submit" loading={pending}>
            Change password
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
