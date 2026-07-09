import { z } from 'zod';

/**
 * Central, validated environment configuration.
 *
 * Required vars are validated at import time so a misconfigured deploy fails
 * fast with a clear message. During `next build` (Docker image build) the
 * real secrets are usually absent, so set `SKIP_ENV_VALIDATION=1` to bypass.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // Database
  DATABASE_URL: z.string().url(),

  // Auth (better-auth)
  BETTER_AUTH_SECRET: z.string().min(16),
  BETTER_AUTH_URL: z.string().url(),

  // AI — story styling via OpenRouter (OpenAI-compatible)
  OPENROUTER_API_KEY: z.string().min(1),
  STYLING_MODEL: z.string().default('anthropic/claude-opus-4-8'),
  OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  // Send in-chat photos to the agent as images. Set 'false' if STYLING_MODEL is a
  // text-only model — it would otherwise reject the request.
  AGENT_VISION: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // AI — transcription via Groq Whisper
  GROQ_API_KEY: z.string().min(1),
  TRANSCRIBE_MODEL: z.string().default('whisper-large-v3-turbo'),
  // Root URL only — groq-sdk appends /openai/v1 to its request paths itself.
  GROQ_BASE_URL: z.string().url().default('https://api.groq.com'),

  // Object storage (S3-compatible)
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  // Force path-style addressing (MinIO / some providers); 'true' to enable.
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

type Env = z.infer<typeof schema>;

function loadEnv(): Env {
  if (process.env.SKIP_ENV_VALIDATION) {
    // Build-time / lint-time escape hatch — return raw values uncoerced.
    return process.env as unknown as Env;
  }

  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const env = loadEnv();
