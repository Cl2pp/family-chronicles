'use client';

import { useState } from 'react';
import { Button, Group, PasswordInput, Stack, Text } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { authClient } from '@/lib/auth-client';
import { useI18n } from '@/lib/i18n/client';

export function ChangePasswordForm({ hasPassword }: { hasPassword: boolean }) {
  const { t } = useI18n();
  const [pending, setPending] = useState(false);
  const form = useForm({
    initialValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
    validate: {
      currentPassword: (v) => (v ? null : t.account.enterCurrentPassword),
      newPassword: (v) => (v.length >= 8 ? null : t.auth.atLeast8Chars),
      confirmPassword: (v, values) =>
        v === values.newPassword ? null : t.account.passwordsDontMatch,
    },
  });

  if (!hasPassword) {
    return (
      <Text c="dimmed" size="sm">
        {t.account.noPasswordYet}
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
        notifications.show({ message: t.account.passwordChanged });
        form.reset();
      } else if (error.code === 'INVALID_PASSWORD') {
        form.setFieldError('currentPassword', t.account.currentPasswordIncorrect);
      } else if (error.code === 'PASSWORD_TOO_SHORT' || error.code === 'PASSWORD_TOO_LONG') {
        form.setFieldError('newPassword', error.message ?? t.account.invalidNewPassword);
      } else {
        notifications.show({
          color: 'red',
          message: error.message ?? t.account.couldNotChangePassword,
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
          label={t.account.currentPassword}
          autoComplete="current-password"
          {...form.getInputProps('currentPassword')}
        />
        <PasswordInput
          label={t.account.newPassword}
          autoComplete="new-password"
          {...form.getInputProps('newPassword')}
        />
        <PasswordInput
          label={t.account.confirmNewPassword}
          autoComplete="new-password"
          {...form.getInputProps('confirmPassword')}
        />
        <Group justify="flex-end">
          <Button type="submit" loading={pending}>
            {t.account.changePassword}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
