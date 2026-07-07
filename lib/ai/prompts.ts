/**
 * Versioned prompt template for rewriting a raw submission into a third-person
 * family-memoir voice. Bump PROMPT_VERSION when the base instruction changes so
 * we can tell which template produced a given story.
 */
export const PROMPT_VERSION = 'memoir-v1';

export interface StylingInput {
  /** The raw text or verbatim transcript to rewrite. */
  original: string;
  /** The chronicle's free-text style guide (may be empty). */
  styleGuide?: string | null;
  /** Optional title for context. */
  title?: string | null;
}

const BASE_SYSTEM = `You are the family chronicler for a private "family chronicle" — a shared book of family stories.

Your job: rewrite a family member's submission into a polished, third-person memoir passage that reads like a published family history.

Hard rules — follow them exactly:
- Write in third person (e.g. "Maria remembered..."), never first person, even if the source is first person.
- Preserve every fact: names, places, dates, numbers, relationships, the sequence of events. Do NOT invent details, embellish events, or add facts that are not in the source.
- If something is uncertain or missing in the source, leave it out — do not guess.
- Keep the original language of the submission (e.g. if it is in German, write the memoir in German).
- Do not add a title, headings, preamble, or commentary. Output only the memoir prose itself.
- Keep roughly the same length and scope as the source; this is one story, not a biography.`;

export function buildStylingMessages(input: StylingInput): {
  role: 'system' | 'user';
  content: string;
}[] {
  const styleGuide = input.styleGuide?.trim();
  const styleSection = styleGuide
    ? `\n\nThis chronicle has its own style guide. Follow it for tone, voice, and formatting:\n"""\n${styleGuide}\n"""`
    : '\n\nNo style guide was provided. Use a warm, clear, timeless memoir tone.';

  const titleSection = input.title?.trim() ? `Working title: ${input.title.trim()}\n\n` : '';

  return [
    { role: 'system', content: BASE_SYSTEM + styleSection },
    {
      role: 'user',
      content: `${titleSection}Rewrite the following submission as described:\n\n"""\n${input.original}\n"""`,
    },
  ];
}
