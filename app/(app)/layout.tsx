import { requireUser } from '@/lib/session';
import { presignGet } from '@/lib/s3';
import { imageTypeForKey } from '@/lib/uploads';
import { getActiveChronicle } from '@/lib/active-chronicle';
import { AppChrome } from '@/components/app-shell';
import { InstallPrompt } from '@/components/install-prompt';
import { VerifyEmailBanner } from '@/components/verify-email-banner';
import { PostHogIdentify } from '@/components/posthog-identify';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const [avatarUrl, { chronicles, active }] = await Promise.all([
    user.image ? presignGet(user.image, imageTypeForKey(user.image)) : Promise.resolve(null),
    getActiveChronicle(user.id),
  ]);

  return (
    <AppChrome
      user={{ name: user.name, email: user.email, avatarUrl }}
      chronicles={chronicles.map((c) => ({ id: c.id, name: c.name }))}
      activeChronicleId={active?.id ?? null}
    >
      <PostHogIdentify userId={user.id} name={user.name} email={user.email} />
      {/* Only logged-in users get the home-screen nudge — never login/landing. */}
      <InstallPrompt />
      {!user.emailVerified && <VerifyEmailBanner email={user.email} />}
      {children}
    </AppChrome>
  );
}
