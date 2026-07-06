import { requireUser } from '@/lib/session';
import { AppChrome } from '@/components/app-shell';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  return (
    <AppChrome user={{ name: user.name, email: user.email }}>{children}</AppChrome>
  );
}
