import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { magicLink } from 'better-auth/plugins';
import { db } from '@/db';
import * as schema from '@/db/schema';
import { env } from '@/lib/env';

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
  session: {
    // Private family app on trusted devices: keep people signed in for a year.
    // The session (and its cookie) slides — any visit at least a day after the
    // last refresh re-issues both — so only a full year of absence logs you out.
    // The better-auth default of 7 days is what kept logging out pinned PWAs.
    expiresIn: 60 * 60 * 24 * 365,
    updateAge: 60 * 60 * 24,
  },
  plugins: [
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        // TODO: wire a real email provider (Resend/SMTP). For now, log the link
        // so it works in local/dev without an email service.
        console.log(`[magic-link] for ${email}: ${url}`);
      },
    }),
  ],
});

export type Session = typeof auth.$Infer.Session;
