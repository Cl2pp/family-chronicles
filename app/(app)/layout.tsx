import { requireUser } from '@/lib/session';
import { presignGet } from '@/lib/s3';
import { imageTypeForKey } from '@/lib/uploads';
import { AppChrome } from '@/components/app-shell';
import { VerifyEmailBanner } from '@/components/verify-email-banner';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const avatarUrl = user.image ? await presignGet(user.image, imageTypeForKey(user.image)) : null;

  return (
    <AppChrome user={{ name: user.name, email: user.email, avatarUrl }}>
      {!user.emailVerified && <VerifyEmailBanner email={user.email} />}
      {children}
    </AppChrome>
  );
}
