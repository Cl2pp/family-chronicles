import { z } from 'zod';
import { findPendingPeopleDraft, resolvePeopleCard } from '@/lib/conversations';
import { applyPeopleChanges } from '@/lib/people-changes';
import { defineTool } from './types';

/**
 * The five people-mutation tools only STAGE changes onto a confirmation card — the
 * normal way to apply or cancel it is the card's own Apply/Discard buttons
 * (app/(app)/chat/people-changes-card.tsx, via the confirmPeopleChanges/
 * discardPeopleChanges server actions). These two tools exist ONLY for when the user
 * says so in words instead of tapping ("ja, übernimm das" / "never mind, forget that") —
 * BASE_SYSTEM tells the model when to reach for them.
 */

/** confirm_people_changes — apply the pending tree-changes card because the user said so in chat. */
export const confirmPeopleChangesTool = defineTool({
  name: 'confirm_people_changes',
  description:
    'Apply the pending tree-changes confirmation card. Only call this when the user EXPLICITLY ' +
    'confirms in chat words (e.g. "yes, apply that") — not needed when they use the card\'s own Apply button.',
  schema: z.object({}),
  async execute(_args, ctx) {
    if (!ctx.conversationId) return { ok: false, error: 'No active conversation.' };
    const pending = await findPendingPeopleDraft(ctx.conversationId);
    if (!pending) return { ok: false, error: 'There is no pending tree-changes card to confirm.' };

    const { receipts, errors } = await applyPeopleChanges(pending.draft, ctx.userId);
    await resolvePeopleCard(pending.messageId);

    const applied = receipts.length
      ? `Applied ${receipts.length} change${receipts.length === 1 ? '' : 's'}.`
      : 'Nothing could be applied.';
    const failed = errors.length ? ` ${errors.length} failed: ${errors.join('; ')}` : '';
    return { ok: true, message: `${applied}${failed}`, receipts };
  },
});

/** cancel_people_changes — discard the pending tree-changes card because the user said so in chat. */
export const cancelPeopleChangesTool = defineTool({
  name: 'cancel_people_changes',
  description:
    'Discard the pending tree-changes confirmation card without applying it. Only call this when the ' +
    'user EXPLICITLY rejects it in chat words — not needed when they use the card\'s own Discard button.',
  schema: z.object({}),
  async execute(_args, ctx) {
    if (!ctx.conversationId) return { ok: false, error: 'No active conversation.' };
    const pending = await findPendingPeopleDraft(ctx.conversationId);
    if (!pending) return { ok: false, error: 'There is no pending tree-changes card to cancel.' };

    await resolvePeopleCard(pending.messageId);
    return { ok: true, message: 'Discarded the pending tree-changes card — nothing was applied.' };
  },
});
