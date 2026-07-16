'use client';

import { useState } from 'react';
import { Alert, Button } from '@mantine/core';
import { IconMailExclamation } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { authClient } from '@/lib/auth-client';
import { useI18n } from '@/lib/i18n/client';

/**
 * Shown on every app page while the user's email is unverified (gated by the
 * app layout). Verification is never required to use the app — it unlocks
 * Google sign-in on this account (see lib/auth.ts) — so this is a nudge, not
 * a gate. Resend goes through better-auth's send-verification-email endpoint.
 */
export function VerifyEmailBanner({ email }: { email: string }) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  async function resend() {
    setLoading(true);
    const { error } = await authClient.sendVerificationEmail({
      email,
      callbackURL: '/chat',
    });
    setLoading(false);
    if (error) {
      notifications.show({ color: 'red', message: error.message ?? t.auth.signUpFailed });
      return;
    }
    setSent(true);
    notifications.show({ message: t.auth.verificationSent });
  }

  return (
    <Alert
      icon={<IconMailExclamation size={18} />}
      title={t.auth.verifyEmailTitle}
      color="yellow"
      mb="md"
    >
      {t.auth.verifyEmailBody}{' '}
      <Button
        variant="light"
        color="yellow"
        size="compact-sm"
        mt="xs"
        display="block"
        loading={loading}
        disabled={sent}
        onClick={resend}
      >
        {sent ? t.auth.verificationSent : t.auth.resendVerification}
      </Button>
    </Alert>
  );
}
