/**
 * Versioned prompt template for rewriting a raw submission into the chronicle's story
 * voice — third-person family memoir by default, but a chronicle's style guide overrides
 * that. Bump PROMPT_VERSION when the base instruction changes so we can tell which
 * template produced a given story.
 */
export const PROMPT_VERSION = 'memoir-v3';

export interface StylingInput {
  /** The raw text or verbatim transcript to rewrite. */
  original: string;
  /** The chronicle's free-text style guide (may be empty). */
  styleGuide?: string | null;
  /** Target language for the memoir ('en' | 'de'); null/undefined = keep the source language. */
  language?: string | null;
  /** Optional title for context. */
  title?: string | null;
}

/** Prompt-facing names for the chronicle's story-language setting. */
const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  de: 'German',
};

const BASE_SYSTEM = `You are the family chronicler for a private "family chronicle" — a shared book of family stories.

Your job: rewrite a family member's submission into a polished passage that reads like a published family history.

Facts — absolute, nothing overrides them:
- Preserve every fact: names, places, dates, numbers, relationships, the sequence of events. Do NOT invent details, embellish events, or add facts that are not in the source.
- If something is uncertain or missing in the source, leave it out — do not guess.
- {{LANGUAGE_RULE}}
- Do not add a title, headings, or a preamble, and never comment on the task itself. Output only the passage.
- Keep roughly the same length and scope as the source; this is one story, not a biography.

Default voice — the house style, in force unless the chronicle's style guide says otherwise:
- Write in third person (e.g. "Maria remembered..."), never first person, even if the source is first person.
- A warm, clear, timeless memoir tone.`;

export function buildStylingMessages(input: StylingInput): {
  role: 'system' | 'user';
  content: string;
}[] {
  const languageName = input.language ? (LANGUAGE_NAMES[input.language] ?? input.language) : null;
  const languageRule = languageName
    ? `Write the memoir in ${languageName}, regardless of the language of the submission — translate faithfully if needed.`
    : 'Keep the original language of the submission (e.g. if it is in German, write the memoir in German).';

  const styleGuide = input.styleGuide?.trim();
  const styleSection = styleGuide
    ? '\n\nThis chronicle has its own style guide, set by the family. It OVERRIDES the default voice ' +
      'wherever the two conflict: if it asks for first-person narration, a greeting at the end, a ' +
      'signature from the teller, or any other departure, follow the style guide, not the default. ' +
      `The facts rules above still hold.\n"""\n${styleGuide}\n"""`
    : '\n\nNo style guide was provided. Use the default voice as written.';

  const titleSection = input.title?.trim() ? `Working title: ${input.title.trim()}\n\n` : '';

  return [
    { role: 'system', content: BASE_SYSTEM.replace('{{LANGUAGE_RULE}}', languageRule) + styleSection },
    {
      role: 'user',
      content: `${titleSection}Rewrite the following submission as described:\n\n"""\n${input.original}\n"""`,
    },
  ];
}
