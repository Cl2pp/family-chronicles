import { env } from '@/lib/env';
import { openrouter, OPENROUTER_ROUTING } from './client';
import { buildStylingMessages, type StylingInput } from './prompts';

/** Rewrite a raw submission into the third-person memoir voice. */
export async function styleStory(input: StylingInput): Promise<string> {
  const messages = buildStylingMessages(input);

  const completion = await openrouter.chat.completions.create({
    model: env.STYLING_MODEL,
    messages,
    ...OPENROUTER_ROUTING,
  });

  const text = completion.choices[0]?.message?.content?.trim();
  if (!text) {
    throw new Error('Styling model returned an empty response');
  }
  return text;
}
