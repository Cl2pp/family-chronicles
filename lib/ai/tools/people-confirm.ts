import { z } from 'zod';
import { claimPeopleCard, findPendingPeopleDraft } from '@/lib/conversations';
import { applyPeopleChanges } from '@/lib/people-changes';
import { defineTool, type ToolContext, type ToolResult } from './types';

/**
 * The five people-mutation tools only STAGE changes onto a confirmation card — the
 * normal way to apply or cancel it is the card's own Apply/Discard buttons
 * (app/(app)/chat/people-changes-card.tsx, via the confirmPeopleChanges/
 * discardPeopleChanges server actions). These two tools exist ONLY for when the user
 * says so in words instead of tapping ("ja, übernimm das" / "never mind, forget that") —
 * BASE_SYSTEM tells the model when to reach for them.
 *
 * Note on state: at the start of every turn, ctx.peopleDraft is SEEDED with the
 * still-pending card's changes (see respondAndStore), and same-turn staging appends to
 * it. So ctx.peopleDraft here is always the complete set the user has been shown —
 * apply/discard means resolving the persisted card AND consuming the in-turn draft.
 */

/** Resolve the pending persisted card exclusively, or explain why not. `null` means
 *  there simply is no persisted card (a same-turn-only draft is still fine to act on). */
async function claimPendingCard(
  ctx: ToolContext,
): Promise<{ claimed: boolean } | { error: string }> {
  if (!ctx.conversationId) return { claimed: false };
  const pending = await findPendingPeopleDraft(ctx.conversationId);
  if (!pending) return { claimed: false };
  if (!(await claimPeopleCard(pending.messageId))) {
    return { error: 'The pending card was just applied or discarded by the user — check the conversation notes.' };
  }
  return { claimed: true };
}

/** confirm_people_changes — apply the staged tree changes because the user said so in chat. */
export const confirmPeopleChangesTool = defineTool({
  name: 'confirm_people_changes',
  description:
    'Apply the pending tree-changes card (including anything staged earlier in THIS turn). Only ' +
    'call this on the user\'s EXPLICIT say-so in chat words (e.g. "yes, apply that", "add them, ' +
    "no need to ask\") — not needed when they use the card's own Apply button.",
  schema: z.object({}),
  async execute(_args, ctx): Promise<ToolResult> {
    const draft = ctx.peopleDraft;
    if (!draft?.changes.length) return { ok: false, error: 'There are no staged tree changes to apply.' };

    const card = await claimPendingCard(ctx);
    if ('error' in card) return { ok: false, error: card.error };

    const { receipts, errors } = await applyPeopleChanges(draft, ctx.userId);
    ctx.peopleDraft = null; // applied — the turn must not also emit a card for it

    const applied = receipts.length
      ? `Applied ${receipts.length} change${receipts.length === 1 ? '' : 's'}.`
      : 'Nothing could be applied.';
    const failed = errors.length ? ` ${errors.length} failed: ${errors.join('; ')}` : '';
    return { ok: true, message: `${applied}${failed}`, receipts };
  },
});

/** cancel_people_changes — discard the staged tree changes because the user said so in chat. */
export const cancelPeopleChangesTool = defineTool({
  name: 'cancel_people_changes',
  description:
    'Discard the pending tree-changes card (and anything staged earlier in THIS turn) without ' +
    'applying anything. Only call this when the user EXPLICITLY rejects the changes in chat ' +
    "words — not needed when they use the card's own Discard button.",
  schema: z.object({}),
  async execute(_args, ctx): Promise<ToolResult> {
    const hadDraft = Boolean(ctx.peopleDraft?.changes.length);
    const card = await claimPendingCard(ctx);
    if ('error' in card) return { ok: false, error: card.error };
    if (!hadDraft && !card.claimed) {
      return { ok: false, error: 'There are no staged tree changes to cancel.' };
    }

    ctx.peopleDraft = null;
    return { ok: true, message: 'Discarded the staged tree changes — nothing was applied.' };
  },
});
