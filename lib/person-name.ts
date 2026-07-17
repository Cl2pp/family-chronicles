/**
 * Name display helpers. Client-safe (no db imports) — lib/people.ts pulls in the
 * database, so client components import these from here instead.
 */

interface NamedPerson {
  firstName: string;
  familyName: string | null;
}

/**
 * "First Last" — the first name(s) plus the surname. Legacy rows may still hold a
 * full name in firstName, so the surname is only appended when it isn't already there.
 */
export function personFullName(p: NamedPerson): string {
  const name = p.firstName.trim();
  const surname = p.familyName?.trim();
  if (!surname) return name;
  return name.toLowerCase().includes(surname.toLowerCase()) ? name : `${name} ${surname}`;
}

/** The surname at birth, when it's set and actually differs from the current surname. */
export function birthSurname(p: NamedPerson & { birthFamilyName: string | null }): string | null {
  const birth = p.birthFamilyName?.trim();
  if (!birth) return null;
  return birth.toLowerCase() === p.familyName?.trim().toLowerCase() ? null : birth;
}
