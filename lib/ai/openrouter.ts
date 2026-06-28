import OpenAI from 'openai';
import { env } from '@/lib/env';
import { buildStylingMessages, type StylingInput } from './prompts';

/**
 * OpenRouter is OpenAI-API-compatible, so we use the official `openai` SDK
 * pointed at OpenRouter's base URL. The model is `env.STYLING_MODEL`, a config
 * value you can change to trade cost vs quality without touching code.
 */
const client = new OpenAI({
  apiKey: env.OPENROUTER_API_KEY,
  baseURL: env.OPENROUTER_BASE_URL,
  defaultHeaders: {
    'HTTP-Referer': env.BETTER_AUTH_URL,
    'X-Title': 'Family Chronicle',
  },
});

/** Rewrite a raw submission into the third-person memoir voice. */
export async function styleStory(input: StylingInput): Promise<string> {
  const messages = buildStylingMessages(input);

  const completion = await client.chat.completions.create({
    model: env.STYLING_MODEL,
    messages,
  });

  const text = completion.choices[0]?.message?.content?.trim();
  if (!text) {
    throw new Error('Styling model returned an empty response');
  }
  return text;
}
