import { cookies } from 'next/headers';
import { requireUser } from '@/lib/session';
import { listFamiliesForUser } from '@/lib/families';
import { AppChrome } from '@/components/app-shell';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const fams = await listFamiliesForUser(user.id);
  const families = fams.map((c) => ({ id: c.id, name: c.name, role: c.role }));

  const cookieStore = await cookies();
  const activeFamilyId = cookieStore.get('activeFamilyId')?.value;

  return (
    <AppChrome
      user={{ name: user.name, email: user.email }}
      families={families}
      activeFamilyId={activeFamilyId}
    >
      {children}
    </AppChrome>
  );
}
