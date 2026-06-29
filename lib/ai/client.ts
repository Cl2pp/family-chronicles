import OpenAI from 'openai';
import { env } from '@/lib/env';

/**
 * Shared OpenRouter client. OpenRouter is OpenAI-API-compatible, so we use the
 * official `openai` SDK pointed at OpenRouter's base URL. Both the styling pass
 * (`lib/ai/openrouter.ts`) and the chat assistant (`lib/ai/chat.ts`) use this
 * single client; the model is chosen per-call via `env.STYLING_MODEL`.
 */
export const openrouter = new OpenAI({
  apiKey: env.OPENROUTER_API_KEY,
  baseURL: env.OPENROUTER_BASE_URL,
  defaultHeaders: {
    'HTTP-Referer': env.BETTER_AUTH_URL,
    'X-Title': 'Family Chronicle',
  },
});
