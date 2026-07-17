'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Anchor,
  Button,
  Checkbox,
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

function SignupForm() {
  const router = useRouter();
  const { t } = useI18n();
  const params = useSearchParams();
  const next = params.get('next') || '/chat';
  const [loading, setLoading] = useState(false);

  const form = useForm({
    initialValues: {
      name: '',
      email: '',
      password: '',
      confirmPassword: '',
      acceptPrivacy: false,
    },
    validate: {
      name: (v) => (v.trim().length >= 2 ? null : t.auth.tellUsYourName),
      email: (v) => (/^\S+@\S+\.\S+$/.test(v) ? null : t.auth.enterValidEmail),
      password: (v) => (v.length >= 8 ? null : t.auth.atLeast8Chars),
      confirmPassword: (v, values) =>
        v === values.password ? null : t.auth.passwordsDoNotMatch,
      // Explicit consent covers the privacy policy incl. Art. 9 content and
      // the US transfers to AI processors described there (Art. 49 DSGVO).
      acceptPrivacy: (v) => (v ? null : t.auth.consentRequired),
    },
  });

  async function handleSubmit(values: typeof form.values) {
    setLoading(true);
    const { error, data } = await authClient.signUp.email({
      name: values.name.trim(),
      email: values.email,
      password: values.password,
      // Where the emailed verification link drops the user after confirming.
      callbackURL: next,
    });
    setLoading(false);
    if (error) {
      notifications.show({ color: 'red', message: error.message ?? t.auth.signUpFailed });
      return;
    }
    // The user_signed_up event is captured server-side (lib/auth.ts hooks);
    // identify here just ties the anonymous browser session to the account.
    if (data?.user && posthog.__loaded) {
      posthog.identify(data.user.id, { name: data.user.name, email: data.user.email });
    }
    notifications.show({ message: t.auth.checkInboxAfterSignup });
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
          <PasswordInput
            label={t.auth.confirmPassword}
            {...form.getInputProps('confirmPassword')}
          />
          <Checkbox
            size="sm"
            label={
              <>
                {t.auth.consentIntro}{' '}
                <Anchor href="/datenschutz" target="_blank" fz="sm">
                  {t.auth.consentPrivacyPolicy}
                </Anchor>
                {t.auth.consentOutro}
              </>
            }
            {...form.getInputProps('acceptPrivacy', { type: 'checkbox' })}
          />
          <Button type="submit" loading={loading} fullWidth>
            {t.home.createAccount}
          </Button>
          <GoogleAuthButton
            next={next}
            beforeStart={() => !form.validateField('acceptPrivacy').hasError}
            requestSignUp
          />
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
