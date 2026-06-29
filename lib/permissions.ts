export type AccessRole = 'owner' | 'contributor' | 'viewer';

const RANK: Record<AccessRole, number> = { viewer: 0, contributor: 1, owner: 2 };

/** Can read (any member). */
export function canView(role: AccessRole) {
  return RANK[role] >= RANK.viewer;
}

/** Can add/edit own stories, tag people, manage the tree, share into this family. */
export function canContribute(role: AccessRole) {
  return RANK[role] >= RANK.contributor;
}

/** Can manage members, invites, settings; edit anything; delete the family. */
export function canManage(role: AccessRole) {
  return RANK[role] >= RANK.owner;
}

export function roleLabel(role: AccessRole) {
  return role.charAt(0).toUpperCase() + role.slice(1);
}
