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
    'Apply the pending tree-changes confirmation card, or the changes staged earlier in THIS turn ' +
    'when the user already told you to apply them without a confirmation step. Only call this on the ' +
    "user's EXPLICIT say-so in chat words (e.g. \"yes, apply that\", \"add them, no need to ask\") — " +
    "not needed when they use the card's own Apply button.",
  schema: z.object({}),
  async execute(_args, ctx) {
    // Changes staged earlier in this same turn take priority: they exist only in the
    // turn's collector (nothing is persisted until the turn ends), and applying an
    // OLDER pending card here instead would silently do the wrong thing.
    if (ctx.peopleDraft?.changes.length) {
      const { receipts, errors } = await applyPeopleChanges(ctx.peopleDraft, ctx.userId);
      ctx.peopleDraft = null; // applied — the turn must not also emit a card for it
      return { ok: true, message: appliedSummary(receipts.length, errors), receipts };
    }

    if (!ctx.conversationId) return { ok: false, error: 'No active conversation.' };
    const pending = await findPendingPeopleDraft(ctx.conversationId);
    if (!pending) return { ok: false, error: 'There is no pending tree-changes card to confirm.' };

    const { receipts, errors } = await applyPeopleChanges(pending.draft, ctx.userId);
    await resolvePeopleCard(pending.messageId);
    return { ok: true, message: appliedSummary(receipts.length, errors), receipts };
  },
});

function appliedSummary(applied: number, errors: string[]): string {
  const ok = applied ? `Applied ${applied} change${applied === 1 ? '' : 's'}.` : 'Nothing could be applied.';
  const failed = errors.length ? ` ${errors.length} failed: ${errors.join('; ')}` : '';
  return `${ok}${failed}`;
}

/** cancel_people_changes — discard the pending tree-changes card because the user said so in chat. */
export const cancelPeopleChangesTool = defineTool({
  name: 'cancel_people_changes',
  description:
    'Discard the pending tree-changes confirmation card (or the changes staged earlier in THIS turn) ' +
    'without applying anything. Only call this when the user EXPLICITLY rejects the changes in chat ' +
    "words — not needed when they use the card's own Discard button.",
  schema: z.object({}),
  async execute(_args, ctx) {
    if (ctx.peopleDraft?.changes.length) {
      ctx.peopleDraft = null;
      return { ok: true, message: 'Dropped the changes staged this turn — nothing was applied.' };
    }

    if (!ctx.conversationId) return { ok: false, error: 'No active conversation.' };
    const pending = await findPendingPeopleDraft(ctx.conversationId);
    if (!pending) return { ok: false, error: 'There is no pending tree-changes card to cancel.' };

    await resolvePeopleCard(pending.messageId);
    return { ok: true, message: 'Discarded the pending tree-changes card — nothing was applied.' };
  },
});
