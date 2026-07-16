import sharp from 'sharp';
import type { ChatCompletionContentPart, ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { env } from '@/lib/env';
import { openrouter } from '@/lib/ai/client';
import { getObjectBuffer } from '@/lib/s3';
import {
  backfillDimensionsFromOriginals,
  loadBook,
  paragraphs,
  wordCount,
  type LoadedBook,
  type PhotoRef,
} from '@/lib/book-content';
import { checkPlanConsistency, validateLayoutPlan, type LayoutPlan, type PlanContent } from '@/lib/book-layout-plan';

/**
 * The AI design pass (docs/BOOK_LAYOUT_PLAN.md §5, producer #2): a vision-capable model
 * looks at a book's chapters AND its actual photos and proposes a `LayoutPlan` — the same
 * shape the deterministic auto-layouter (`lib/book-autolayout.ts`) produces, but informed
 * by what's actually IN the photos (who's in them, composition, which one is the emotional
 * hero) rather than just their pixel dimensions. Worker-side only (Chromium-adjacent job,
 * downloads originals). Never throws: any failure — request error, unparseable/invalid JSON,
 * schema or consistency failure — is logged and returns `null`, so the caller (the
 * `design-book` worker handler) can fall back to the auto-layouter silently.
 */

/** Hard cap on how many photos ride along as actual image bytes (vision is the expensive,
 *  slow part of the request) — every other photo is still described in the text metadata,
 *  just not shown. Spread across chapters, highest-resolution first within each. */
const MAX_VISION_IMAGES = 30;

/** Minimum remaining word count to float a portrait beside text — mirrors the auto-layouter's
 *  FLOAT_MIN_WORDS so the model's floats behave the same as the heuristic's. */
const FLOAT_MIN_WORDS = 120;

interface ChapterInput {
  storyId: string;
  title: string;
  eventLabel: string | null;
  paragraphs: string[];
  images: Array<PhotoRef & { width: number; height: number }>;
}

function aspectLabel(width: number, height: number): string {
  const orientation = width > height ? 'landscape' : width < height ? 'portrait' : 'square';
  return `${width}x${height} (${orientation})`;
}

/** Picks which images get sent as actual vision input, capped and spread across chapters:
 *  round-robin the chapters, each round taking that chapter's next-highest-resolution
 *  not-yet-picked image, until every image is picked or the cap is hit. */
function selectVisionImages(chapters: ChapterInput[], cap: number): Set<string> {
  const pools = chapters
    .map((c) => [...c.images].sort((a, b) => b.width * b.height - a.width * a.height))
    .filter((pool) => pool.length > 0);
  const picked = new Set<string>();
  let idx = 0;
  while (picked.size < cap) {
    let madeProgress = false;
    for (let round = 0; round < pools.length; round++) {
      const pool = pools[(idx + round) % pools.length];
      const next = pool.shift();
      if (next) {
        picked.add(next.id);
        madeProgress = true;
        if (picked.size >= cap) break;
      }
    }
    idx++;
    if (!madeProgress) break;
  }
  return picked;
}

const BLOCK_SCHEMA_TEXT = `The layout plan is a single JSON object with this exact shape:

{
  "theme": "classic",
  "cover": { "style": "framed" | "full-bleed", "heroAssetId": "<assetId>" },
  "chapters": [
    { "storyId": "<storyId>", "blocks": [ <block>, <block>, ... ] }
  ]
}

Every chapter you were given MUST appear exactly once in "chapters", using its exact storyId.

A <block> is one of:

  { "type": "paragraphs", "from": <int>, "to": <int> }
    A run of the chapter's own paragraphs, by 0-based index, INCLUSIVE on both ends.
    Every paragraph of a chapter must be covered by exactly one such block, in ascending,
    non-overlapping, gap-free order, together covering every index from 0 to (count - 1).

  { "type": "figure", "assetId": "<assetId>", "size": "full" | "float-left" | "float-right" }
    One photo. "full" spans the column (use for landscape/square photos, or any photo when
    there isn't much text left to wrap around it). "float-left"/"float-right" float a
    portrait-oriented photo beside the text that follows — ONLY use these when at least
    ${FLOAT_MIN_WORDS} words of that chapter's paragraph text still come after this block;
    otherwise the image floats over empty space. Alternate float-left/float-right through a
    chapter rather than always picking the same side.

  { "type": "photo-row", "assetIds": ["<assetId>", "<assetId>"] }
    Exactly two photos side by side at one shared height, together filling the full width of
    the text column — no cropping, whatever the orientation mix. The default way to place two
    photos: it fills the page instead of leaving white space beside a lone image.

  { "type": "photo-grid", "assetIds": ["<assetId>", "<assetId>", "<assetId>", "<assetId>"?] }
    Three or four photos as one dominant + smaller companions, filling the full column width.
    Good for a cluster of photos from the same moment.

  { "type": "photo-page", "assetId": "<assetId>" }
    One photo filling its own entire page — rendered as large as the page allows, centered,
    with a white mat frame around it and the caption beneath. Reserve this for the single
    most striking image of a photo-heavy chapter — it costs a whole page.

"cover.heroAssetId" is optional but strongly preferred: the id of ANY photo in the book (not
necessarily this chapter's) to use as the book's cover image. Omit it only if no photo in the
whole book is a good cover.`;

const SYSTEM_PROMPT = `You are an experienced photo-book designer working for "Familienwerk", a private family memoir app. You are given one family's book: its chapters (each one story, already written in third-person memoir prose) with their paragraphs, and the chapter's photos — both as metadata (id, pixel size, caption) and, for the more important ones, as actual images you can see. Your job is to propose a JSON "layout plan" that says exactly how the book should be typeset: which paragraphs go where, and where each photo appears and at what size.

${BLOCK_SCHEMA_TEXT}

Hard rules — a plan that breaks any of these will be discarded and the book falls back to a plain automatic layout, wasting this design pass entirely:
- Every paragraph of every chapter appears exactly once, in order, via "paragraphs" blocks — no gaps, no overlaps, no paragraph skipped or duplicated.
- Only ever reference an assetId you were actually given for that chapter (or, for the cover, any assetId given anywhere in the book). Never invent an id.
- "photo-row" needs exactly 2 assetIds. "photo-grid" needs 3 or 4.
- Only use "float-left"/"float-right" when enough paragraph text follows in that same chapter (see the block rules above) — otherwise use "full".
- Output ONLY the JSON object. No markdown code fences, no explanation before or after, nothing but the JSON.

Design goals — this is where your judgment as a designer (and the ability to actually see the photos) matters, and is the entire reason this pass exists instead of a mechanical layout:
- FILL THE PAGE, SYMMETRICALLY. Never leave a photo hugging one side of the page with white space beside it, and never leave a small photo alone in a sea of empty page. Prefer "photo-row" and "photo-grid" groupings that span the full column width; a photo that deserves to stand alone should be a "photo-page" (it fills the page) rather than a small solitary figure. A little white space is fine — a quarter-page photo floating in emptiness is not.
- Pick the single most emotionally striking photo in the whole book as the cover hero (cover.heroAssetId) — ideally a warm, clear, well-composed photo of people (a face, a moment, a smile), not a blurry shot, a landscape, or an object.
- Within each chapter, order its photos to follow the story being told — a photo of an event described early in the paragraphs should appear near that part of the text, not dumped at the end regardless of what it shows.
- Never crop a person awkwardly: a portrait-oriented photo of people belongs in a slot that keeps it upright and uncropped in the important dimension — a float, a photo-row, or a photo-grid slot — rather than forced into a "full" figure sized for landscape photos.
- In a chapter with several strong photos, consider promoting the single best one to its own "photo-page" for pacing and weight — but don't do this in every chapter, or it loses its effect.
- Vary the rhythm across the book. Do not give every chapter the identical block pattern (e.g. paragraphs → figure → paragraphs → photo-grid every time) — some chapters can be almost all text with one quiet photo, others can open on a strong image, others can build to a photo-page. A book that "breathes" differently chapter to chapter reads as designed, not generated.
- It is fine, and sometimes right, to leave out a weak, redundant, or blurry-sounding photo entirely — you do not have to place every photo you were shown.`;

/** Builds the per-chapter text description (paragraph list + image metadata) that always
 *  goes into the request, vision or not. */
function chapterMetadataText(chapter: ChapterInput): string {
  const lines: string[] = [];
  lines.push(`### Chapter — storyId: ${chapter.storyId}`);
  lines.push(`Title: ${chapter.title}`);
  lines.push(`Event year: ${chapter.eventLabel ?? 'unknown'}`);
  lines.push('');
  lines.push(`Paragraphs (${chapter.paragraphs.length}):`);
  chapter.paragraphs.forEach((p, i) => {
    const words = wordCount(p);
    lines.push(`  [${i}] (${words} words) ${p}`);
  });
  lines.push('');
  if (chapter.images.length === 0) {
    lines.push('Photos: none.');
  } else {
    lines.push(`Photos (${chapter.images.length}):`);
    for (const img of chapter.images) {
      lines.push(
        `  - assetId: ${img.id}, size: ${aspectLabel(img.width, img.height)}${img.caption ? `, caption: "${img.caption}"` : ''}`,
      );
    }
  }
  return lines.join('\n');
}

/** Longest edge sent as vision input — plenty for design judgment without shipping
 *  camera originals; matches roughly what the live HTML preview already uses. */
const VISION_MAX_EDGE = 768;
const VISION_JPEG_QUALITY = 80;

/**
 * Encodes a photo as a base64 JPEG data URI for vision input: reads the downscaled
 * thumbnail when one exists (smaller, faster, plenty for design judgment), else the
 * original, normalizing to JPEG so every model in front of OpenRouter can read it
 * regardless of source format (HEIC, orientation-tagged JPEG, etc.).
 *
 * Deliberately NOT a presigned S3 URL: OpenRouter/Anthropic fetch `image_url` values
 * themselves, which requires the object store to be a publicly reachable HTTPS
 * endpoint — untrue for local/self-hosted MinIO and any firewalled deployment. Data
 * URIs work everywhere, and it's the same approach `lib/book-render.ts` already uses
 * to embed photos into the print PDF's HTML.
 *
 * Returns null (never throws) when the source object can't be read/decoded — the
 * caller skips that photo from the vision payload; its metadata (size, caption) still
 * reaches the model via the text description, so nothing vanishes silently.
 */
async function photoVisionDataUri(photo: PhotoRef): Promise<string | null> {
  const sources = photo.thumbS3Key ? [photo.thumbS3Key, photo.s3Key] : [photo.s3Key];
  for (const key of sources) {
    try {
      const buffer = await getObjectBuffer(key);
      const out = await sharp(buffer, { failOn: 'none' })
        .rotate()
        .resize({ width: VISION_MAX_EDGE, height: VISION_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: VISION_JPEG_QUALITY, mozjpeg: true })
        .toBuffer();
      return `data:image/jpeg;base64,${out.toString('base64')}`;
    } catch (e) {
      console.warn(`[book-ai-layout] failed to encode ${key} for vision, trying next source:`, e);
    }
  }
  return null;
}

async function buildMessages(loaded: LoadedBook, chapters: ChapterInput[]): Promise<ChatCompletionMessageParam[]> {
  const visionEnabled = env.AGENT_VISION;
  const visionIds = visionEnabled ? selectVisionImages(chapters, MAX_VISION_IMAGES) : new Set<string>();

  const userParts: ChatCompletionContentPart[] = [];
  const totalImages = chapters.reduce((n, c) => n + c.images.length, 0);
  userParts.push({
    type: 'text',
    text:
      `Design the layout for "${loaded.row.title}" (${chapters.length} chapter${chapters.length === 1 ? '' : 's'}, ${totalImages} photo${totalImages === 1 ? '' : 's'} total). ` +
      (visionEnabled
        ? `You can see ${visionIds.size} of the photos below (the rest are described by metadata only — the highest-resolution photo of each chapter was prioritized for the images you can see).`
        : 'No images are attached to this request — judge composition only from the metadata (size, orientation, caption).') +
      ' Reply with the JSON layout plan only.',
  });

  for (const chapter of chapters) {
    userParts.push({ type: 'text', text: chapterMetadataText(chapter) });
    if (visionEnabled) {
      for (const img of chapter.images) {
        if (!visionIds.has(img.id)) continue;
        const dataUri = await photoVisionDataUri(img);
        if (!dataUri) continue;
        userParts.push({ type: 'text', text: `Photo for assetId ${img.id} (chapter ${chapter.storyId}):` });
        userParts.push({ type: 'image_url', image_url: { url: dataUri } });
      }
    }
  }

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userParts },
  ];
}

/** Strips markdown code fences and any leading/trailing prose, then parses the first
 *  balanced-looking JSON object found. Models asked for "JSON only" sometimes still wrap
 *  the answer in ```json fences or add a sentence before/after — this survives both. */
function extractJson(raw: string): unknown | null {
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last === -1 || last < first) return null;
  try {
    return JSON.parse(text.slice(first, last + 1));
  } catch {
    return null;
  }
}

/**
 * Post-processing carry-over (docs/BOOK_LAYOUT_PLAN.md §6 phase 4): overrides the model's
 * theme/cover.style with whatever plan was already stored, and its cover.heroAssetId with
 * the book's pinned cover (`books.cover_asset_id`) when one is set — the model doesn't get
 * a vote on either, it only reasons about photo placement and (absent a pin) its own cover
 * pick. Mirrors `buildAndPersistAutoPlan`'s carry-over in lib/book-content.ts so both
 * producers behave identically. Exported for testing — the model call itself
 * (proposeLayoutPlan) isn't something a test should invoke for real, but this pure
 * post-processing step is.
 */
export function applyPlanCarryOver(plan: LayoutPlan, loaded: LoadedBook): LayoutPlan {
  const existing = loaded.row.layoutPlan ? validateLayoutPlan(loaded.row.layoutPlan) : null;
  const existingPlan = existing?.ok ? existing.plan : null;

  const theme = existingPlan?.theme ?? plan.theme;
  const style = existingPlan?.cover.style ?? plan.cover.style;
  const pinnedHero = loaded.row.coverAssetId && loaded.allPhotosById.has(loaded.row.coverAssetId)
    ? loaded.row.coverAssetId
    : null;
  const heroAssetId = pinnedHero ?? plan.cover.heroAssetId;

  return {
    ...plan,
    theme,
    cover: heroAssetId ? { style, heroAssetId } : { style },
  };
}

/**
 * Runs the AI design pass for a book. Loads the book's current content, sends the model
 * the chapter text + photo metadata + (vision permitting) the actual photos, and returns
 * a validated `LayoutPlan` — or `null` on any failure, in which case the caller should
 * fall back to the deterministic auto-layouter. Never throws.
 */
export async function proposeLayoutPlan(bookId: string): Promise<LayoutPlan | null> {
  try {
    const loaded = await loadBook(bookId);
    await backfillDimensionsFromOriginals(loaded.allPhotosById);

    const chapters: ChapterInput[] = loaded.chapters.map((c) => ({
      storyId: c.storyId,
      title: c.title,
      eventLabel: c.eventLabel,
      paragraphs: paragraphs(c.body),
      images: c.photoAssets.filter(
        (p): p is PhotoRef & { width: number; height: number } => !!p.width && !!p.height,
      ),
    }));

    const messages = await buildMessages(loaded, chapters);

    const completion = await openrouter.chat.completions.create({
      model: env.STYLING_MODEL,
      messages,
    });

    const text = completion.choices[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) {
      console.error(`[book-ai-layout] design pass for ${bookId} returned no content`);
      return null;
    }

    const parsed = extractJson(text);
    if (!parsed) {
      console.error(`[book-ai-layout] design pass for ${bookId} returned unparseable JSON:`, text.slice(0, 500));
      return null;
    }

    const validated = validateLayoutPlan(parsed);
    if (!validated.ok) {
      console.error(`[book-ai-layout] design pass for ${bookId} failed schema validation: ${validated.error}`);
      return null;
    }

    // Carry theme/cover.style/explicit hero forward from whatever plan is currently
    // stored, same as the auto-layouter (lib/book-content.ts) — the AI freely redesigns
    // photo placement and (absent a pin) its own cover pick, but never silently resets a
    // theme or cover style the user chose, and never overrides a pinned cover photo
    // (`books.cover_asset_id`) even if it would have picked a different hero itself.
    const plan = applyPlanCarryOver(validated.plan, loaded);

    const content: PlanContent = {
      chapters: chapters.map((c) => ({
        storyId: c.storyId,
        paragraphCount: c.paragraphs.length,
        assetIds: c.images.map((i) => i.id),
      })),
      allAssetIds: [...loaded.allPhotosById.keys()],
    };
    const problems = checkPlanConsistency(plan, content);
    if (problems.length > 0) {
      console.error(`[book-ai-layout] design pass for ${bookId} failed consistency check:`, problems);
      return null;
    }

    return plan;
  } catch (err) {
    console.error(`[book-ai-layout] design pass for ${bookId} failed:`, err);
    return null;
  }
}
