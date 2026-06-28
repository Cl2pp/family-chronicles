import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/session';
import { requireMembership, canEdit } from '@/lib/chronicles';
import { StoryComposer } from './composer';

export default async function NewStoryPage({
  params,
}: {
  params: Promise<{ chronicleId: string }>;
}) {
  const { chronicleId } = await params;
  const user = await requireUser();
  const membership = await requireMembership(chronicleId, user.id);
  if (!canEdit(membership.role)) redirect(`/chronicles/${chronicleId}`);

  return <StoryComposer chronicleId={chronicleId} />;
}
