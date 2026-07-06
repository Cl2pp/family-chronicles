import { requireUser } from '@/lib/session';
import { presignGet } from '@/lib/s3';
import { AppChrome } from '@/components/app-shell';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const avatarUrl = user.image ? await presignGet(user.image) : null;

  return (
    <AppChrome user={{ name: user.name, email: user.email, avatarUrl }}>
      {children}
    </AppChrome>
  );
}
