import { getMembership } from '@/lib/chronicles';
import { listChroniclePeople } from '@/lib/people';
import { canContribute, canManage, type AccessRole } from '@/lib/permissions';
import type { ToolContext } from './types';

/** Resolve the active chronicle + confirm the user can contribute, or return an error string. */
export async function ensureContributor(
  ctx: ToolContext,
): Promise<{ chronicleId: string } | { error: string }> {
  if (!ctx.activeChronicleId) {
    return { error: 'There is no active chronicle yet. Use create_chronicle first.' };
  }
  const m = await getMembership(ctx.activeChronicleId, ctx.userId);
  if (!m) return { error: 'You are not a member of the active chronicle.' };
  if (!canContribute(m.accessRole as AccessRole)) {
    return { error: 'You need contributor access in this chronicle to do that.' };
  }
  return { chronicleId: ctx.activeChronicleId };
}

/** Resolve the active chronicle + confirm the user is an owner, or return an error string. */
export async function ensureOwner(
  ctx: ToolContext,
): Promise<{ chronicleId: string } | { error: string }> {
  if (!ctx.activeChronicleId) {
    return { error: 'There is no active chronicle yet. Use create_chronicle first.' };
  }
  const m = await getMembership(ctx.activeChronicleId, ctx.userId);
  if (!m) return { error: 'You are not a member of the active chronicle.' };
  if (!canManage(m.accessRole as AccessRole)) {
    return { error: 'Only a chronicle owner can do that.' };
  }
  return { chronicleId: ctx.activeChronicleId };
}

type ChroniclePerson = Awaited<ReturnType<typeof listChroniclePeople>>[number];

/**
 * Case-insensitive lookup of a person by display name within a chronicle.
 * Returns the single match, or an error string when missing/ambiguous.
 */
export async function resolvePerson(
  chronicleId: string,
  name: string,
): Promise<{ person: ChroniclePerson } | { error: string }> {
  const wanted = name.trim().toLowerCase();
  const people = await listChroniclePeople(chronicleId);
  const matches = people.filter((p) => p.displayName.toLowerCase() === wanted);
  if (matches.length === 0) {
    return { error: `No one named "${name}" is in this chronicle's tree yet.` };
  }
  if (matches.length > 1) {
    return { error: `More than one person is named "${name}" — ask which one is meant.` };
  }
  return { person: matches[0] };
}
