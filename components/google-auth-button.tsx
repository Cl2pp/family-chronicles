'use client';

import { useState } from 'react';
import { Button, Divider } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { authClient } from '@/lib/auth-client';
import { useI18n } from '@/lib/i18n/client';

/**
 * "Continue with Google" button + divider, shared by the signup and login pages.
 *
 * Renders nothing unless NEXT_PUBLIC_GOOGLE_AUTH_ENABLED is 'true', so the button
 * only appears where Google OAuth is actually configured (server credentials live
 * in lib/auth.ts). Clicking hands off to better-auth's social sign-in, which
 * redirects to Google and back to `next` on success.
 */
export function GoogleAuthButton({
  next,
  beforeStart,
  requestSignUp,
}: {
  next: string;
  /** Gate the redirect (e.g. the signup page's privacy-consent checkbox); return false to abort. */
  beforeStart?: () => boolean;
  /**
   * Allow creating a new account for this Google identity. Only the signup
   * page sets this (after its consent checkbox) — the Google provider has
   * disableImplicitSignUp, so without it unknown users are bounced back to
   * login with ?error=signup_disabled.
   */
  requestSignUp?: boolean;
}) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(false);

  if (process.env.NEXT_PUBLIC_GOOGLE_AUTH_ENABLED !== 'true') return null;

  async function handleClick() {
    if (beforeStart && !beforeStart()) return;
    setLoading(true);
    const { error } = await authClient.signIn.social({
      provider: 'google',
      callbackURL: next,
      requestSignUp,
    });
    // On success the browser is redirected to Google, so we only get here on error.
    if (error) {
      setLoading(false);
      notifications.show({ color: 'red', message: error.message ?? t.auth.signInFailed });
    }
  }

  return (
    <>
      <Divider label={t.auth.or} labelPosition="center" my="xs" />
      <Button
        variant="default"
        fullWidth
        loading={loading}
        onClick={handleClick}
        leftSection={<GoogleIcon />}
      >
        {t.auth.continueWithGoogle}
      </Button>
    </>
  );
}

function GoogleIcon() {
  return (
    <svg width={18} height={18} viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.964 10.706A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.706V4.962H.957A8.997 8.997 0 0 0 0 9c0 1.452.348 2.827.957 4.038l3.007-2.332z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.962L3.964 7.294C4.672 5.167 6.656 3.58 9 3.58z"
      />
    </svg>
  );
}
