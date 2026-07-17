import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { db } from '@/db';
import * as schema from '@/db/schema';
import { env } from '@/lib/env';
import { sendEmail } from '@/lib/email';
import { captureServerEvent } from '@/lib/posthog-server';

/**
 * Analytics label for the auth endpoint that triggered a database hook, so
 * sign-in/sign-up events cover every method (email form AND OAuth redirects,
 * which never come back through our client-side pages). Path shapes follow
 * better-auth's own last-login-method plugin.
 */
function authMethod(ctx?: { path?: string; params?: Record<string, string | undefined> } | null) {
  const path = ctx?.path ?? '';
  if (path.startsWith('/callback/') || path.startsWith('/oauth2/callback/')) {
    return ctx?.params?.id ?? 'oauth';
  }
  if (path === '/sign-in/email' || path === '/sign-up/email') return 'email';
  return 'other';
}

export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
    },
  }),
  emailAndPassword: {
    enabled: true,
  },
  // Verification is "soft": login never requires it (requireEmailVerification
  // stays off so pre-existing accounts keep working), but a verified email is
  // what allows better-auth to link a Google sign-in to an existing
  // email/password account (its default requireLocalEmailVerified check).
  // Unverified users see a banner with a resend button (components/
  // verify-email-banner.tsx). Sending is best-effort: without SMTP_URL the
  // mail is logged instead (lib/email.ts), which is also the local-dev flow.
  emailVerification: {
    sendVerificationEmail: async ({ user, url }) => {
      await sendEmail({
        to: user.email,
        subject: 'Bestätige deine E-Mail-Adresse — Familienwerk',
        text: [
          `Hallo ${user.name || ''}`.trim() + ',',
          '',
          'bitte bestätige deine E-Mail-Adresse für Familienwerk über diesen Link:',
          '',
          url,
          '',
          'Der Link ist 24 Stunden gültig. Wenn du dich nicht bei Familienwerk',
          'registriert hast, kannst du diese E-Mail ignorieren.',
          '',
          '— Familienwerk',
          '',
          '---',
          '',
          'Please confirm your email address for Familienwerk using the link above.',
          'It is valid for 24 hours. If you did not sign up, you can ignore this email.',
        ].join('\n'),
      });
    },
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    // Verification emails sit in family inboxes for a while — the 1h default
    // would expire most links before they're clicked.
    expiresIn: 60 * 60 * 24,
  },
  // OAuth callback failures (e.g. Google login refused because the local
  // account's email isn't verified yet) land on the login page with an
  // ?error=… code instead of better-auth's bare /api/auth/error page.
  onAPIError: {
    errorURL: `${env.BETTER_AUTH_URL}/login`,
  },
  // Wired up only when both credentials are present, so local dev and CI boot
  // without Google configured. The signup/login button is gated separately by
  // NEXT_PUBLIC_GOOGLE_AUTH_ENABLED — set all three together in prod.
  ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
    ? {
        socialProviders: {
          google: {
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
            // No implicit account creation from the LOGIN page: signup must go
            // through the signup form's privacy consent (DSGVO). The signup
            // page's Google button opts back in via `requestSignUp: true`;
            // a first-time Google click on /login redirects there with
            // ?error=signup_disabled instead.
            disableImplicitSignUp: true,
          },
        },
      }
    : {}),
  session: {
    // The session (and its cookie) slides — any visit at least a day after the
    // last refresh re-issues both — so only a month of absence logs you out.
    // (The better-auth default is 7 days.)
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },
  // Server-side analytics for ALL auth methods. The sliding refresh above is
  // an UPDATE, so session.create only fires on genuine sign-ins (including
  // the auto sign-in right after signup/verification — which is one).
  databaseHooks: {
    user: {
      create: {
        after: async (user, ctx) => {
          captureServerEvent(user.id, 'user_signed_up', { method: authMethod(ctx) });
        },
      },
    },
    session: {
      create: {
        after: async (session, ctx) => {
          captureServerEvent(session.userId, 'user_signed_in', { method: authMethod(ctx) });
        },
      },
    },
  },
});

export type Session = typeof auth.$Infer.Session;
