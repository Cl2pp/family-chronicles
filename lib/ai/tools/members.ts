import { z } from 'zod';
import { env } from '@/lib/env';
import { createInvitation } from '@/lib/invitations';
import { listChroniclePeople } from '@/lib/people';
import { findPersonByName } from '@/lib/person-match';
import { defineTool } from './types';
import { ensureOwner } from './util';

/** invite_member — create a shareable invitation link for the active chronicle. Owner only. */
export const inviteMemberTool = defineTool({
  name: 'invite_member',
  description:
    'Invite someone to the active chronicle by email, returning a shareable invite link. The email ' +
    'is not sent automatically — give the user the link to pass on. Owner only.',
  schema: z.object({
    email: z.string().min(1).describe("The invitee's email address."),
    role: z
      .enum(['owner', 'contributor', 'viewer'])
      .default('contributor')
      .describe('Access level: viewer (read), contributor (add stories/tree), or owner (manage).'),
    person: z
      .string()
      .optional()
      .describe(
        'Name of the tree person the invitee IS, if they are already in the family tree. ' +
          'Accepting the invite links their account to that person.',
      ),
  }),
  async execute(args, ctx) {
    const gate = await ensureOwner(ctx);
    if ('error' in gate) return { ok: false, error: gate.error };

    const email = args.email.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return { ok: false, error: 'That does not look like a valid email address.' };
    }

    // Resolve the optional tree person against members not yet linked to an account.
    let personId: string | null = null;
    let personName: string | null = null;
    if (args.person?.trim()) {
      const unlinked = (await listChroniclePeople(gate.chronicleId)).filter((p) => !p.userId);
      const match = findPersonByName(unlinked, args.person);
      if ('error' in match) {
        return {
          ok: false,
          error:
            match.error === 'ambiguous'
              ? `"${args.person}" could mean several unlinked tree people (${match.candidates
                  .map((c) => c.displayName)
                  .join(', ')}) — ask which one is meant.`
              : `No unlinked tree person named "${args.person}" was found — they may not be in the tree yet, or already have an account.`,
        };
      }
      personId = match.person.id;
      personName = match.person.displayName;
    }

    const invite = await createInvitation({
      chronicleId: gate.chronicleId,
      email,
      role: args.role,
      invitedBy: ctx.userId,
      personId,
    });

    const link = `${env.BETTER_AUTH_URL.replace(/\/$/, '')}/invite/${invite.token}`;
    const linkedNote = personName
      ? ` Accepting will link their account to ${personName} in the family tree.`
      : '';
    return {
      ok: true,
      message: `Invitation created for ${email} as ${args.role}.${linkedNote} Share this link: ${link}`,
      receipt: { label: `Invited ${email} (${args.role})`, detail: link, href: `/invite/${invite.token}` },
    };
  },
});
