import { z } from 'zod';
import { env } from '@/lib/env';
import { createInvitation } from '@/lib/invitations';
import { defineTool } from './types';
import { ensureOwner } from './util';

/** invite_member — create a shareable invitation link for the active family. Owner only. */
export const inviteMemberTool = defineTool({
  name: 'invite_member',
  description:
    'Invite someone to the active family by email, returning a shareable invite link. The email ' +
    'is not sent automatically — give the user the link to pass on. Owner only.',
  schema: z.object({
    email: z.string().min(1).describe("The invitee's email address."),
    role: z
      .enum(['owner', 'contributor', 'viewer'])
      .default('contributor')
      .describe('Access level: viewer (read), contributor (add stories/tree), or owner (manage).'),
  }),
  async execute(args, ctx) {
    const gate = await ensureOwner(ctx);
    if ('error' in gate) return { ok: false, error: gate.error };

    const email = args.email.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return { ok: false, error: 'That does not look like a valid email address.' };
    }

    const invite = await createInvitation({
      familyId: gate.familyId,
      email,
      role: args.role,
      invitedBy: ctx.userId,
    });

    const link = `${env.BETTER_AUTH_URL.replace(/\/$/, '')}/invite/${invite.token}`;
    return {
      ok: true,
      message: `Invitation created for ${email} as ${args.role}. Share this link: ${link}`,
      receipt: { label: `Invited ${email} (${args.role})`, detail: link, href: `/invite/${invite.token}` },
    };
  },
});
