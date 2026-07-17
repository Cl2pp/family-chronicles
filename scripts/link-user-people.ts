import 'dotenv/config';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '@/db';
import { chronicleMembers, memberships, people, user } from '@/db/schema';
import { linkUserToPersonIfFree } from '@/lib/people';
import { personFullName } from '@/lib/person-name';

/**
 * Backfill user ↔ tree-person links (docs/STORY_ACCESS_PLAN.md, phase 1). Family-mode
 * story access resolves "the viewer's person" via people.user_id, but historically only
 * chronicle creators were linked — invited accounts never got a person node.
 *
 *   npx tsx scripts/link-user-people.ts --suggest
 *   npx tsx scripts/link-user-people.ts --link <email> <personId>
 *
 * --suggest is read-only: for every membership user without a linked person, list the
 * unlinked tree members of their chronicles whose display name matches the account name
 * (case-insensitively), or all unlinked members when nothing matches.
 * --link applies one link with the same guards as the app (person unlinked and in one
 * of the user's chronicle trees; user has no person). Idempotent: re-running a link
 * that already exists is a no-op; a link elsewhere errors clearly.
 */

/** Chronicle ids the user has access to (memberships). */
async function chronicleIdsForUser(userId: string): Promise<string[]> {
  const rows = await db
    .select({ chronicleId: memberships.chronicleId })
    .from(memberships)
    .where(eq(memberships.userId, userId));
  return rows.map((r) => r.chronicleId);
}

/** Unlinked people in the trees of the given chronicles, deduped by person. */
async function unlinkedTreePeople(chronicleIds: string[]) {
  if (chronicleIds.length === 0) return [];
  return db
    .selectDistinctOn([people.id], {
      id: people.id,
      firstName: people.firstName,
      familyName: people.familyName,
    })
    .from(chronicleMembers)
    .innerJoin(people, eq(chronicleMembers.personId, people.id))
    .where(and(inArray(chronicleMembers.chronicleId, chronicleIds), isNull(people.userId)))
    .orderBy(people.id);
}

async function suggest() {
  // Every distinct membership user, minus those already linked to a person.
  const users = await db
    .selectDistinctOn([user.id], { id: user.id, name: user.name, email: user.email })
    .from(memberships)
    .innerJoin(user, eq(memberships.userId, user.id))
    .orderBy(user.id);
  const linkedRows = await db.select({ userId: people.userId }).from(people);
  const linkedUserIds = new Set(linkedRows.map((r) => r.userId).filter(Boolean));

  let unlinkedUsers = 0;
  for (const u of users) {
    if (linkedUserIds.has(u.id)) continue;
    unlinkedUsers += 1;

    const candidates = await unlinkedTreePeople(await chronicleIdsForUser(u.id));
    const byName = candidates.filter(
      (p) => personFullName(p).trim().toLowerCase() === u.name.trim().toLowerCase(),
    );
    const list = byName.length > 0 ? byName : candidates;
    const marker = byName.length > 0 ? '' : ' (no name match — all unlinked tree members)';
    if (list.length === 0) {
      console.log(`${u.email} → no unlinked tree members in their chronicles`);
      continue;
    }
    for (const p of list) {
      console.log(`${u.email} → ${personFullName(p)} (${p.id})${marker}`);
    }
  }
  console.log(`\n${unlinkedUsers} membership user(s) without a linked person.`);
}

async function link(email: string, personId: string) {
  const [u] = await db.select().from(user).where(eq(user.email, email)).limit(1);
  if (!u) throw new Error(`No user with email ${email}`);
  const person = await db.query.people.findFirst({ where: eq(people.id, personId) });
  if (!person) throw new Error(`No person with id ${personId}`);

  // Idempotency + clear errors before the guarded UPDATE.
  if (person.userId === u.id) {
    console.log(`Already linked: ${u.email} ↔ ${personFullName(person)} (${person.id}) — nothing to do.`);
    return;
  }
  if (person.userId) {
    throw new Error(`${personFullName(person)} (${person.id}) is already linked to another account.`);
  }
  const existing = await db.query.people.findFirst({ where: eq(people.userId, u.id) });
  if (existing) {
    throw new Error(
      `${u.email} is already linked to ${personFullName(existing)} (${existing.id}) — unlink first.`,
    );
  }

  // Same guard as the app: the person must be a tree member of one of the user's chronicles.
  const chronicleIds = await chronicleIdsForUser(u.id);
  const inTree = chronicleIds.length
    ? await db
        .select({ id: chronicleMembers.id })
        .from(chronicleMembers)
        .where(
          and(
            inArray(chronicleMembers.chronicleId, chronicleIds),
            eq(chronicleMembers.personId, personId),
          ),
        )
        .limit(1)
    : [];
  if (inTree.length === 0) {
    throw new Error(
      `${personFullName(person)} (${person.id}) is not a tree member of any of ${u.email}'s chronicles.`,
    );
  }

  const linked = await linkUserToPersonIfFree(personId, u.id);
  if (!linked) throw new Error('Could not link — the person or account was claimed meanwhile.');
  console.log(`Linked ${u.email} ↔ ${personFullName(person)} (${person.id}).`);
}

async function main() {
  const [mode, email, personId] = process.argv.slice(2);
  if (mode === '--suggest') {
    await suggest();
  } else if (mode === '--link' && email && personId) {
    await link(email, personId);
  } else {
    throw new Error(
      'Usage: npx tsx scripts/link-user-people.ts --suggest | --link <email> <personId>',
    );
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
