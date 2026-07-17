import OpenAI from 'openai';
import { env } from '@/lib/env';

/**
 * Shared OpenRouter client. OpenRouter is OpenAI-API-compatible, so we use the
 * official `openai` SDK pointed at OpenRouter's base URL. Both the styling pass
 * (`lib/ai/openrouter.ts`) and the chat agent (`lib/ai/agent.ts`) use this
 * single client; the model is chosen per-call via `env.STYLING_MODEL`.
 */
export const openrouter = new OpenAI({
  apiKey: env.OPENROUTER_API_KEY,
  baseURL: env.OPENROUTER_BASE_URL,
  defaultHeaders: {
    'HTTP-Referer': env.BETTER_AUTH_URL,
    'X-Title': 'Familienwerk',
  },
});

/**
 * OpenRouter routing preferences, spread into every completion request that
 * carries user content (styling, chat agent, book design — i.e. all app/worker
 * call sites). `data_collection: 'deny'` restricts routing to upstream
 * providers that neither log nor train on prompts — these requests carry
 * family stories and photos (DSGVO, potentially Art. 9 content). The demo-seed
 * script's image calls are deliberately excluded: purely fictional prompts,
 * and `deny` would narrow image-model availability. `provider` is an
 * OpenRouter extension the OpenAI SDK doesn't type; spreading it in keeps
 * call sites type-checked for everything else.
 */
export const OPENROUTER_ROUTING = {
  provider: { data_collection: 'deny' },
} as const;
