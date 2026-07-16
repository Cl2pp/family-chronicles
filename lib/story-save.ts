import { matchPeopleByName } from '@/lib/person-match';
import { listChroniclePeople } from '@/lib/people';
import { normalizeText } from '@/lib/story-similarity';
import { partsToEventDate } from '@/lib/dates';
import { claimChatAssetsForStory, createStory, listChronicleStoryTexts } from '@/lib/stories';
import type { StoryProposal } from '@/lib/ai/tools/types';

export interface SavedChatStory {
  storyId: string;
  title: string;
  /** True when an identical story already existed — it was returned, nothing was created. */
  alreadySaved: boolean;
  /** Proposal people that matched no tree member and so could not be connected. */
  unmatchedPeople: string[];
}

/**
 * Persist a chat story proposal as a ready story. Shared by the draft card's accept
 * action and the agent's save_story tool, so both paths behave identically:
 * idempotency (an identical story of the user's in this chronicle means this exact
 * draft was already accepted — return it instead of duplicating), forgiving people
 * resolution, and claiming the chat's raw uploads (voice + photos) for traceability.
 */
export async function saveProposalAsStory(input: {
  userId: string;
  chronicleId: string;
  proposal: StoryProposal;
  conversationId: string | null;
}): Promise<SavedChatStory> {
  const p = input.proposal;
  const title = p.title || 'Untitled story';

  const existing = await listChronicleStoryTexts(input.chronicleId, input.userId);
  const duplicate = existing.find(
    (s) =>
      s.submittedBy === input.userId &&
      normalizeText(s.title) === normalizeText(title) &&
      normalizeText(s.bodyStyled ?? s.bodyOriginal ?? '') === normalizeText(p.body),
  );
  if (duplicate) {
    return { storyId: duplicate.id, title, alreadySaved: true, unmatchedPeople: [] };
  }

  // Resolve any named people to existing tree members in this chronicle (best-effort,
  // forgiving: "Ava" matches "Ava Naoko"). Unmatched names are dropped but reported.
  let personIds: string[] = [];
  let unmatchedPeople: string[] = [];
  if (p.people?.length) {
    const chroniclePeople = await listChroniclePeople(input.chronicleId);
    const { matched, unmatched } = matchPeopleByName(chroniclePeople, p.people);
    personIds = matched.map((fp) => fp.id);
    unmatchedPeople = unmatched;
  }

  const story = await createStory({
    userId: input.userId,
    title,
    summary: p.summary || null,
    // The user's verbatim words are the raw source; the styled draft is only a
    // fallback for cards persisted before sourceText existed.
    bodyOriginal: p.sourceText?.trim() || p.body,
    bodyStyled: p.body,
    inputType: 'chat',
    status: 'ready',
    ...partsToEventDate({ year: p.eventYear, month: p.eventMonth, day: p.eventDay }),
    conversationId: input.conversationId,
    chronicleIds: [input.chronicleId],
    personIds,
  });

  // Carry the chat's raw uploads (voice + photos) onto the story for traceability.
  // Only the ones no earlier story from this chat already claimed.
  if (input.conversationId) {
    await claimChatAssetsForStory(input.conversationId, story.id, input.userId);
  }

  return { storyId: story.id, title, alreadySaved: false, unmatchedPeople };
}
