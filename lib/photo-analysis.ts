import { z } from 'zod';

/**
 * `PhotoAnalysis` — the AI vision-scoring result for one photo (docs/PHOTO_BOOK_PLAN.md
 * §4), and the pure pieces of the `photo-vision` batched job (`lib/photo-vision.ts`):
 * the zod schema, batch splitting, and parsing/validating a model's raw JSON response.
 *
 * Deliberately free of any `db`/`env`/`openrouter` import — those pull in
 * `lib/env.ts`'s eager, throwing env validation (see its module-level `export const env
 * = loadEnv()`), which fails outside a fully-configured process (this repo's vitest run
 * has none of the required vars set, and isn't meant to). Keeping this module pure is
 * what makes it unit-testable at all (`lib/photo-analysis.test.ts`); the DB/S3/model
 * orchestration around it lives in `lib/photo-vision.ts`, which is not unit-tested for
 * the same reason `lib/book-ai-layout.ts` isn't — see that file's `applyPlanCarryOver`,
 * exported "for testing" but with no test importing it today, same constraint.
 */

/** ~10 thumbnails per OpenRouter request (docs/PHOTO_BOOK_PLAN.md §4: "batches of ~10
 *  thumbnails per request") — enough to amortize request overhead without a single
 *  giant prompt, and small enough that one bad/oversized photo doesn't waste a large
 *  batch's worth of output tokens if the model chokes on it. */
export const PHOTO_VISION_BATCH_SIZE = 10;

export const PHOTO_SHARPNESS_VALUES = ['sharp', 'soft', 'blurry'] as const;
export const photoSharpnessSchema = z.enum(PHOTO_SHARPNESS_VALUES);
export type PhotoSharpness = z.infer<typeof photoSharpnessSchema>;

/** One photo's vision-scoring result — matches `book_photos.analysis` (jsonb) and the
 *  `PhotoAnalysis` shape in docs/PHOTO_BOOK_PLAN.md §4 exactly. */
export const photoAnalysisSchema = z.object({
  /** 0–10: composition, light, the moment itself. */
  aestheticScore: z.number().min(0).max(10),
  sharpness: photoSharpnessSchema,
  /** Any clearly-closed/blinking eyes on a visible face; false when there are no faces
   *  or every visible eye is open. */
  eyesClosed: z.boolean(),
  peopleCount: z.number().int().min(0),
  /** Short, lowercase content tags — 'beach', 'birthday', 'group photo', … */
  sceneTags: z.array(z.string()),
  /** One plain sentence describing the photo — used for captions (rewritten into the
   *  chronicle's language by the design pass) and as agent context in later PRs. */
  shortDescription: z.string(),
  /** A warm, clear, well-composed photo of people — a candidate for the book cover or a
   *  section opener. */
  coverCandidate: z.boolean(),
});
export type PhotoAnalysis = z.infer<typeof photoAnalysisSchema>;

/** The raw shape one array item must have in the model's response: a `PhotoAnalysis`
 *  plus the `assetId` it scores — the correlation key, since the model is free to
 *  return its answers in any order (and might skip one it couldn't judge). */
const visionResponseItemSchema = photoAnalysisSchema.extend({
  assetId: z.string().min(1),
});

/** Splits `assetIds` into fixed-size batches (last one may be smaller) — the pure half
 *  of "an enqueue helper that splits a book's pending photos into ~10-id batches"
 *  (docs/PHOTO_BOOK_PLAN.md PR3 scope). Order-preserving, no I/O. */
export function splitIntoVisionBatches(
  assetIds: string[],
  batchSize: number = PHOTO_VISION_BATCH_SIZE,
): string[][] {
  if (batchSize <= 0) throw new Error('batchSize must be positive');
  const batches: string[][] = [];
  for (let i = 0; i < assetIds.length; i += batchSize) {
    batches.push(assetIds.slice(i, i + batchSize));
  }
  return batches;
}

/** Strips markdown code fences and any leading/trailing prose, then parses the first
 *  balanced-looking JSON ARRAY found — the array counterpart of `extractJson` in
 *  `lib/book-ai-layout.ts` (that one looks for `{`/`}`; a vision batch's answer is a
 *  top-level array of per-photo objects, not a single object). */
export function extractJsonArray(raw: string): unknown[] | null {
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const first = text.indexOf('[');
  const last = text.lastIndexOf(']');
  if (first === -1 || last === -1 || last < first) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(first, last + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface ParsedVisionBatch {
  /** assetId -> validated analysis, only for array items that both parsed as JSON and
   *  passed schema validation. */
  results: Map<string, PhotoAnalysis>;
  /** assetIds present in the response but whose entry failed schema validation —
   *  distinct from an assetId the model simply omitted (which the caller detects itself
   *  by diffing against the batch it sent, since an omitted id leaves no trace here). */
  invalidIds: string[];
}

/**
 * Parses + validates a `photo-vision` batch response: extracts the JSON array (tolerant
 * of markdown fences/stray prose, like the story design pass), then schema-validates
 * each item independently — one bad item never invalidates the whole batch, mirroring
 * `analyzePhotoMeta`'s "everything is best-effort per photo" philosophy. Returns `null`
 * only when no JSON array could be found at all (the model's answer was unusable
 * end-to-end); an array that parsed but contains zero valid items still returns a
 * `ParsedVisionBatch` with an empty `results` map, so the caller can tell "nothing here
 * was JSON" from "the JSON was well-formed but every item was junk".
 */
export function parseVisionBatchResponse(raw: string): ParsedVisionBatch | null {
  const arr = extractJsonArray(raw);
  if (!arr) return null;

  const results = new Map<string, PhotoAnalysis>();
  const invalidIds: string[] = [];
  for (const item of arr) {
    const parsed = visionResponseItemSchema.safeParse(item);
    if (parsed.success) {
      const { assetId, ...analysis } = parsed.data;
      results.set(assetId, analysis);
      continue;
    }
    const maybeId =
      item && typeof item === 'object' && 'assetId' in item && typeof (item as { assetId?: unknown }).assetId === 'string'
        ? (item as { assetId: string }).assetId
        : null;
    if (maybeId) invalidIds.push(maybeId);
  }
  return { results, invalidIds };
}

/**
 * Defensively re-validates a `book_photos.analysis` jsonb value read back from the
 * database — it was written by `parseVisionBatchResponse`'s validated output, so this
 * should always succeed, but jsonb is untyped storage and this is cheap insurance
 * against a hand-edited row or a future schema change (mirrors `validatePhotoBookPlan`'s
 * role for `books.layout_plan`). Returns `null` for anything that doesn't validate,
 * including `null`/`undefined` itself.
 */
export function parseStoredPhotoAnalysis(raw: unknown): PhotoAnalysis | null {
  if (raw == null) return null;
  const parsed = photoAnalysisSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
