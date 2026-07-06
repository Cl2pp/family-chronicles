import { getMembership } from '@/lib/families';
import { listFamilyPeople } from '@/lib/people';
import { canContribute, canManage, type AccessRole } from '@/lib/permissions';
import type { ToolContext } from './types';

/** Resolve the active family + confirm the user can contribute, or return an error string. */
export async function ensureContributor(
  ctx: ToolContext,
): Promise<{ familyId: string } | { error: string }> {
  if (!ctx.activeFamilyId) {
    return { error: 'There is no active family yet. Use create_family first.' };
  }
  const m = await getMembership(ctx.activeFamilyId, ctx.userId);
  if (!m) return { error: 'You are not a member of the active family.' };
  if (!canContribute(m.accessRole as AccessRole)) {
    return { error: 'You need contributor access in this family to do that.' };
  }
  return { familyId: ctx.activeFamilyId };
}

/** Resolve the active family + confirm the user is an owner, or return an error string. */
export async function ensureOwner(
  ctx: ToolContext,
): Promise<{ familyId: string } | { error: string }> {
  if (!ctx.activeFamilyId) {
    return { error: 'There is no active family yet. Use create_family first.' };
  }
  const m = await getMembership(ctx.activeFamilyId, ctx.userId);
  if (!m) return { error: 'You are not a member of the active family.' };
  if (!canManage(m.accessRole as AccessRole)) {
    return { error: 'Only a family owner can do that.' };
  }
  return { familyId: ctx.activeFamilyId };
}

type FamilyPerson = Awaited<ReturnType<typeof listFamilyPeople>>[number];

/**
 * Case-insensitive lookup of a person by display name within a family.
 * Returns the single match, or an error string when missing/ambiguous.
 */
export async function resolvePerson(
  familyId: string,
  name: string,
): Promise<{ person: FamilyPerson } | { error: string }> {
  const wanted = name.trim().toLowerCase();
  const people = await listFamilyPeople(familyId);
  const matches = people.filter((p) => p.displayName.toLowerCase() === wanted);
  if (matches.length === 0) {
    return { error: `No one named "${name}" is in this family's tree yet.` };
  }
  if (matches.length > 1) {
    return { error: `More than one person is named "${name}" — ask which one is meant.` };
  }
  return { person: matches[0] };
}
