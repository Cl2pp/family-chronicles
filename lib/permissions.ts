export type AccessRole = 'owner' | 'contributor' | 'viewer';

const RANK: Record<AccessRole, number> = { viewer: 0, contributor: 1, owner: 2 };

/** Can add/edit own stories, tag people, manage the tree, share into this chronicle. */
export function canContribute(role: AccessRole) {
  return RANK[role] >= RANK.contributor;
}

/** Can manage members, invites, settings; edit anything; delete the chronicle. */
export function canManage(role: AccessRole) {
  return RANK[role] >= RANK.owner;
}
