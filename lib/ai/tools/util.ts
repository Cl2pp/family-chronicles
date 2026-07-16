import { getMembership } from '@/lib/chronicles';
import { listChroniclePeople } from '@/lib/people';
import { findPersonByName } from '@/lib/person-match';
import { personFullName } from '@/lib/person-name';
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
 * Case-insensitive lookup of a person by name within a chronicle — exact display name
 * first, then unique forgiving matches ("Ava" → "Ava Naoko", "Clemens Ortlepp" →
 * Clemens with familyName Ortlepp). Returns the single match, or an error string.
 */
export async function resolvePerson(
  chronicleId: string,
  name: string,
): Promise<{ person: ChroniclePerson } | { error: string }> {
  const people = await listChroniclePeople(chronicleId);
  const result = findPersonByName(people, name);
  if ('person' in result) return { person: result.person };
  if (result.error === 'ambiguous') {
    const names = result.candidates.map((c) => personFullName(c)).join(', ');
    return { error: `"${name}" could mean several people (${names}) — ask which one is meant.` };
  }
  return { error: `No one named "${name}" is in this chronicle's tree yet.` };
}
