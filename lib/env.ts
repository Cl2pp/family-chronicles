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
  // Google OAuth (optional). Both must be set to enable Google sign-in; the
  // provider is wired up only when both are present (see lib/auth.ts), and the
  // client-side button is gated separately by NEXT_PUBLIC_GOOGLE_AUTH_ENABLED.
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),

  // AI — story styling via OpenRouter (OpenAI-compatible)
  OPENROUTER_API_KEY: z.string().min(1),
  STYLING_MODEL: z.string().default('anthropic/claude-sonnet-5'),
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

  // Books — print-on-demand via Gelato + admin order notification.
  // All optional: without a key the order screen shows "price on request",
  // without SMTP the notification is logged instead of sent.
  GELATO_API_KEY: z.string().min(1).optional(),
  GELATO_PRODUCT_UID_21X28: z
    .string()
    .default(
      'photobooks-hardcover_pf_210x280-mm-8x11-inch_pt_170-gsm-65lb-coated-silk_cl_4-4_ccl_4-4_bt_glued-left_ct_matt-lamination_prt_1-0_cpt_130-gsm-65-lb-cover-coated-silk_ver',
    ),
  GELATO_PRODUCT_UID_20X20: z
    .string()
    .default(
      'photobooks-hardcover_pf_200x200-mm-8x8-inch_pt_170-gsm-65lb-coated-silk_cl_4-4_ccl_4-4_bt_glued-left_ct_matt-lamination_prt_1-0_cpt_130-gsm-65-lb-cover-coated-silk_ver',
    ),
  /** Flat margin (EUR) added on top of Gelato's product + shipping cost. */
  BOOK_MARGIN_EUR: z.coerce.number().default(15),
  /** Shown on the order screen — users email this address to request a printed book. */
  BOOK_ORDER_CONTACT_EMAIL: z.string().email().default('clemens@mtx.studio'),
  /** smtp(s)://user:pass@host:port — used by lib/email.ts (dormant until a flow sends mail). */
  SMTP_URL: z.string().optional(),
  SMTP_FROM: z.string().default('Familienwerk <no-reply@familienwerk.co>'),
  /** System Chromium for the book renderer (set in Docker; empty = puppeteer's own). */
  PUPPETEER_EXECUTABLE_PATH: z.string().optional(),

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
