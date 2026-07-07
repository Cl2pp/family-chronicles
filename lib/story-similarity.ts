/**
 * Text-similarity heuristics to catch the same memory being recorded twice.
 * Everything here is language-agnostic (plain token overlap, no stemming) so it
 * works for whatever language the family writes in.
 */

/** Lowercase, strip diacritics + punctuation, collapse whitespace. */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(s: string): Set<string> {
  return new Set(normalizeText(s).split(' ').filter(Boolean));
}

function sharedTokenCount(a: string, b: string): number {
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared;
}

/**
 * Token containment: shared tokens over the SMALLER set (not the union), so a
 * short title/summary still scores high against a longer retelling of it.
 */
export function textSimilarity(a: string, b: string): number {
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.min(ta.size, tb.size);
}

export interface StoryCandidate {
  id: string;
  title: string;
  summary: string | null;
  body: string | null;
  eventYear: number | null;
}

export interface DuplicateMatch {
  id: string;
  title: string;
  eventYear: number | null;
  reason: string;
}

const TITLE_STRONG = 0.8;
const TITLE_WEAK = 0.5;
const BODY_WEAK = 0.35;
const BODY_STRONG = 0.6;

/**
 * Stories that likely describe the same event as the draft. Conservative on
 * purpose: a year conflict means "probably a different event", so it then takes
 * near-identical text to flag. Returns at most 3 matches, best first.
 */
export function findLikelyDuplicates(
  draft: { title: string; body: string; eventYear: number | null },
  candidates: StoryCandidate[],
): DuplicateMatch[] {
  const scored: Array<DuplicateMatch & { score: number }> = [];

  for (const c of candidates) {
    const titleSim = textSimilarity(draft.title, c.title);
    const bodySim = textSimilarity(draft.body, `${c.summary ?? ''} ${c.body ?? ''}`);
    const yearsConflict =
      draft.eventYear != null && c.eventYear != null && draft.eventYear !== c.eventYear;

    // A short title that is a subset of a longer one ("Weihnachten" vs "Weihnachten
    // bei Oma Else") scores 1.0 on containment — the strong branch needs at least two
    // shared title tokens. One-word matches fall through to the weak branch, which
    // demands real content overlap too.
    const titleCorroborated = sharedTokenCount(draft.title, c.title) >= 2;

    let reason: string | null = null;
    if (!yearsConflict && titleSim >= TITLE_STRONG && titleCorroborated) {
      reason = 'nearly identical title';
    } else if (!yearsConflict && titleSim >= TITLE_WEAK && bodySim >= BODY_WEAK) {
      reason = 'similar title and overlapping content';
    } else if (bodySim >= BODY_STRONG && titleSim >= (yearsConflict ? TITLE_WEAK : 0)) {
      reason = 'very similar content';
    }
    if (reason) {
      scored.push({ id: c.id, title: c.title, eventYear: c.eventYear, reason, score: titleSim + bodySim });
    }
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((m) => ({ id: m.id, title: m.title, eventYear: m.eventYear, reason: m.reason }));
}
