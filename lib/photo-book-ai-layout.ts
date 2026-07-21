import type { ChatCompletionContentPart, ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { chronicles } from '@/db/schema';
import { env } from '@/lib/env';
import { openrouter, OPENROUTER_ROUTING } from '@/lib/ai/client';
import { encodePhotoForVision } from '@/lib/vision-image';
import { loadPhotoBook, type LoadedPhotoBook, type PhotoBookPhotoRef } from '@/lib/photo-book-content';
import { computeCandidateSections, type AutoLayoutPhoto } from '@/lib/photo-book-autolayout';
import {
  checkPhotoBookPlanConsistency,
  validatePhotoBookPlan,
  PHOTO_BOOK_STYLES,
  PHOTO_PAGE_TEMPLATES,
  PHOTO_PAGE_TEMPLATE_SLOTS,
  type PhotoBookPlan,
  type PhotoPlanContent,
} from '@/lib/photo-book-plan';
import { referencedPhotoAssetIds } from '@/lib/photo-book-content';

/**
 * The photo-book AI design pass (docs/PHOTO_BOOK_PLAN.md §6, producer #2) — the
 * photo-book counterpart of `lib/book-ai-layout.ts`'s `proposeLayoutPlan`, mirrored as
 * closely as the two domains allow: a vision-capable model looks at the book's photos
 * (metadata for ALL of them, actual images for a capped, spread-out subset) and proposes
 * a complete `PhotoBookPlan` — section boundaries and titles, hero pick, page-template
 * pacing, optional captions — replacing the deterministic auto-layouter's mechanical
 * date-range sections with something that reads as designed. Same never-throws contract:
 * any failure (request error, unparseable/invalid JSON, schema or consistency failure)
 * is logged and returns `null`, so the caller (the `design-photo-book` worker handler)
 * falls back to `buildAndPersistPhotoAutoPlan` silently.
 *
 * Uses `STYLING_MODEL`, not `VISION_MODEL` — the per-photo scoring batches
 * (`lib/photo-vision.ts`) are the cheap, high-volume call that gets the flash-lite model;
 * this is the one-per-"Design my book"-click call where judgment quality matters, exactly
 * like the story book's design pass (docs/PHOTO_BOOK_PLAN.md §4).
 *
 * Deliberately does NOT touch `lib/book-ai-layout.ts` or anything it imports — the
 * story-book AI design pass is out of scope for this PR and stays byte-for-byte as it
 * was; this file and `lib/vision-image.ts` exist so the two new PR3 vision call sites
 * don't have to duplicate `photoVisionDataUri`'s ~15 lines a second time.
 */

/** Hard cap on how many photos ride along as actual image bytes — mirrors
 *  `lib/book-ai-layout.ts`'s `MAX_VISION_IMAGES`, just bigger: a photo book can run to
 *  hundreds of photos across many sections, and docs/PHOTO_BOOK_PLAN.md §6 specifically
 *  asks for "the top ~40 candidates". Every other available photo still reaches the
 *  model as text (id, time, cluster, scores, description) — just not as pixels. */
const MAX_VISION_IMAGES = 40;

/** Neutral rank contribution for a photo with no vision score yet — keeps an unscored
 *  photo from being sorted dead last (it might still be a fine pick), without letting it
 *  outrank a photo the vision pass actively liked. */
const NEUTRAL_RANK_SCORE = 5;

function orientation(width: number, height: number): 'landscape' | 'portrait' | 'square' {
  const ratio = width / height;
  return ratio > 1.1 ? 'landscape' : ratio < 0.9 ? 'portrait' : 'square';
}

/** Ranks a photo for vision-image selection: explicit `coverCandidate` first, then
 *  `aestheticScore` (unscored treated as neutral), then resolution as a final tiebreak —
 *  the same priority order `pickBestPhoto` in `lib/photo-book-autolayout.ts` uses for
 *  hero/opener selection, so the photos the model gets to actually SEE are the ones most
 *  likely to matter for its hero/opener choices. */
function visionRank(photo: AutoLayoutPhoto): number {
  // A force-included photo (docs/PHOTO_BOOK_PLAN.md re-include fix) always wins the pick —
  // the user explicitly asked for it, so if it can ride along as an actual image within
  // the MAX_VISION_IMAGES cap, it should, giving the model the best shot at actually
  // placing it (see the completeness check in `proposePhotoBookPlan` below, which falls
  // back to the auto layout if the model leaves a force-included photo out anyway).
  const forced = photo.userDecision === 'include' ? 1_000_000 : 0;
  const cover = photo.analysis?.coverCandidate ? 1 : 0;
  const aesthetic = photo.analysis?.aestheticScore ?? NEUTRAL_RANK_SCORE;
  const resolutionTiebreak = (photo.width * photo.height) / 1e8; // sub-1 nudge, never flips a real ranking
  return forced + cover * 1000 + aesthetic * 10 + resolutionTiebreak;
}

/** Picks which photos get sent as actual vision input, capped and spread across the
 *  candidate sections (round-robin, best-ranked-first within each) — mirrors
 *  `selectVisionImages` in `lib/book-ai-layout.ts`, with `visionRank` swapped in for
 *  "highest resolution" now that scores exist to rank by. */
function selectVisionImages(sections: AutoLayoutPhoto[][], cap: number): Set<string> {
  const pools = sections
    .map((section) => [...section].sort((a, b) => visionRank(b) - visionRank(a)))
    .filter((pool) => pool.length > 0);
  const picked = new Set<string>();
  let idx = 0;
  while (picked.size < cap) {
    let madeProgress = false;
    for (let round = 0; round < pools.length; round++) {
      const pool = pools[(idx + round) % pools.length];
      const next = pool.shift();
      if (next) {
        picked.add(next.assetId);
        madeProgress = true;
        if (picked.size >= cap) break;
      }
    }
    idx++;
    if (!madeProgress) break;
  }
  return picked;
}

function templateVocabularyText(): string {
  const descriptions: Record<(typeof PHOTO_PAGE_TEMPLATES)[number], string> = {
    'full-bleed': 'one photo, fills the page edge-to-edge — hero moments',
    'full-framed': 'one photo, matted with a white frame',
    'two-horizontal': 'two landscape photos stacked',
    'two-vertical': 'two portrait photos side by side',
    'three-column': 'three portrait photos as columns',
    'three-mixed': 'three photos, one dominant + two small',
    'collage-4': 'four photos, a justified mosaic row',
    'collage-5': 'five photos, a justified mosaic row',
    divider: 'section opener — title/date only, or with one muted photo',
  };
  return PHOTO_PAGE_TEMPLATES.map((t) => {
    const { min, max } = PHOTO_PAGE_TEMPLATE_SLOTS[t];
    const arity = min === max ? `exactly ${min}` : `${min}-${max}`;
    return `  "${t}" — ${arity} photo${max === 1 ? '' : 's'} — ${descriptions[t]}`;
  }).join('\n');
}

function schemaText(): string {
  return `The layout plan is a single JSON object with this exact shape:

{
  "kind": "photo",
  "style": ${PHOTO_BOOK_STYLES.map((s) => `"${s}"`).join(' | ')},
  "cover": {
    "heroAssetId": "<assetId>",
    "title": "<the book's title — fixed by the user's own settings, just echo the current title from the prompt below; this field is required by the schema but your value here is not used>",
    "subtitle": "<optional, same as title — echo the current subtitle if there is one>",
    "backAssetIds": ["<assetId>", ...]   // optional, 0-3 small photos for the back cover
  },
  "sections": [
    {
      "title": "<a title named from what's actually IN the photos, e.g. \\"Am Strand\\" — NOT a generic date range>",
      "dateLabel": "<optional short date range, e.g. \\"Juni 2025\\", shown as a subtitle under the title>",
      "pages": [ <page>, <page>, ... ]
    }
  ]
}

A <page> is: { "template": <one of the templates below>, "assetIds": ["<assetId>", ...], "captions": ["<short caption or null>", ...] }
"captions" is optional; when present it must have exactly one entry per assetId (use null for a photo you don't want a caption on).

Page templates (assetIds count must match exactly):
${templateVocabularyText()}`;
}

const HARD_RULES = `Hard rules — a plan that breaks any of these will be discarded and the book falls back to a plain automatic layout, wasting this design pass entirely:
- Only ever reference an assetId from the "Available photos" list below. Never invent one.
- No assetId may appear more than once anywhere in the whole plan — not as the cover hero, not in cover.backAssetIds, not on two different pages. In particular: if a photo is the cover hero, it must NOT also appear on any section page.
- Every section must have at least one page.
- A page's "assetIds" length must exactly match its template's photo count (see the template list).
- If "captions" is present on a page, it must have exactly as many entries as "assetIds".
- Any photo marked "[MUST BE INCLUDED — the user manually re-added this photo]" in the photo list below MUST appear somewhere in your plan (as the cover hero, a cover back photo, or on a section page) — never leave one of these out, no matter how weak/blurry/redundant it looks. This is a hard requirement, not a suggestion: a plan missing one of these photos is discarded just like an invalid one.
- Output ONLY the JSON object. No markdown code fences, no explanation before or after, nothing but the JSON.`;

/** Fetches the chronicle's story-language setting (`chronicles.story_language`) for a
 *  book — used to write section titles/captions in the family's language. Falls back to
 *  German, matching the auto-layouter's own `dateLocale` default (`'de-DE'`) and the
 *  app's German-first default locale. */
async function chronicleLanguageName(chronicleId: string): Promise<string> {
  const [row] = await db
    .select({ storyLanguage: chronicles.storyLanguage })
    .from(chronicles)
    .where(eq(chronicles.id, chronicleId))
    .limit(1);
  return row?.storyLanguage === 'en' ? 'English' : 'German';
}

function systemPrompt(languageName: string): string {
  return `You are an experienced photo-book designer working for "Familienwerk", a private family memoir app. You are given one family's photo book: every available photo's metadata (id, when/roughly where it was taken, a candidate time-based cluster, its vision-analysis scores if available, and its pixel size) and, for the more important ones, the actual images. Your job is to propose a JSON "layout plan" (docs/PHOTO_BOOK_PLAN.md §5) that groups the photos into sections, gives each section a real title, picks a cover hero, and lays every section out page by page.

${schemaText()}

${HARD_RULES}

Design goals — this is where your judgment (and the ability to actually see the photos) matters, and is the entire reason this pass exists instead of a mechanical date-range layout:
- NAME sections from what's actually in them ("Am Strand", "Omas Geburtstag") rather than a generic date range — put the date range in "dateLabel" instead if you want to keep it visible.
- Keep sections in roughly chronological order (matching the photos' capture times) — this is a family memoir on a timeline, not a shuffled gallery.
- Pick the cover hero: prefer a photo whose analysis marks it "coverCandidate", and among those the highest "aestheticScore" — a warm, clear, well-composed photo of people, not a blurry or eyes-closed one. The cover's title/subtitle text is fixed by the user's own settings and not yours to change — spend your judgment on the hero pick instead.
- FILL THE PAGE, SYMMETRICALLY. Never leave a photo hugging one side of the page with white space beside it; prefer templates that span the full width (two-*, three-*, collage-*) for photos that go together, and reserve "full-bleed"/"full-framed" for photos that deserve to stand alone.
- Vary the rhythm across sections — don't give every section the identical page pattern. A section opener is usually its own strong single-photo page; some sections can build to another strong single-photo page mid-way; others stay all multi-photo pages. A book that "breathes" differently section to section reads as designed, not generated.
- It is fine, and often right, to leave out a weak, redundant, blurry, or eyes-closed-with-no-good-alternative photo entirely — favor photos with a high "aestheticScore" and no eyes-closed flag when you have a choice; you do not have to place every available photo.
- Optional short captions (one plain sentence, drawn from a photo's "description") are a nice touch on a handful of the most meaningful photos — not required on every photo, and not on dense collages (there's no room).
- Write every "title", "dateLabel", and caption in ${languageName}.`;
}

/** Formats one AutoLayoutPhoto (plus its candidate cluster index) as one line of the
 *  text-only "analysis table" every available photo appears in, scored or not. */
function photoTableLine(photo: AutoLayoutPhoto, clusterIndex: number): string {
  const taken = photo.takenAt ? photo.takenAt.toISOString().slice(0, 16).replace('T', ' ') : 'unknown';
  const gps = photo.gpsLat != null && photo.gpsLng != null ? `${photo.gpsLat.toFixed(2)},${photo.gpsLng.toFixed(2)}` : 'none';
  const size = `${photo.width}x${photo.height} (${orientation(photo.width, photo.height)})`;
  const a = photo.analysis;
  const analysisText = a
    ? `aesthetic ${a.aestheticScore.toFixed(1)}, ${a.sharpness}, eyesClosed=${a.eyesClosed}, people=${a.peopleCount}, cover=${a.coverCandidate}, tags=[${a.sceneTags.join(', ')}], "${a.shortDescription}"`
    : 'not yet scored';
  // See the HARD_RULES entry this exact phrase is matched against in the system prompt.
  const forcedTag = photo.userDecision === 'include' ? ' [MUST BE INCLUDED — the user manually re-added this photo]' : '';
  return `  - assetId: ${photo.assetId}, taken: ${taken}, gps: ${gps}, cluster: ${clusterIndex}, size: ${size}, ${analysisText}${forcedTag}`;
}

/** Converts a `PhotoBookPhotoRef` (as loaded by `loadPhotoBook`) into the shape
 *  `computeCandidateSections`/`pickBestPhoto`-adjacent ranking helpers expect — only
 *  photos with known dimensions can be laid out or ranked at all (mirrors
 *  `buildAndPersistPhotoAutoPlan`'s same filter in `lib/photo-book-content.ts`). */
function toAutoLayoutPhotos(
  photos: PhotoBookPhotoRef[],
): (AutoLayoutPhoto & { s3Key: string; thumbS3Key: string | null })[] {
  return photos
    .filter((p): p is PhotoBookPhotoRef & { width: number; height: number } => p.width != null && p.height != null)
    .map((p) => ({
      assetId: p.assetId,
      width: p.width,
      height: p.height,
      position: p.position,
      takenAt: p.takenAt,
      gpsLat: p.gpsLat,
      gpsLng: p.gpsLng,
      phash: p.phash,
      blurScore: p.blurScore,
      analysis: p.analysis,
      userDecision: p.userDecision,
      s3Key: p.s3Key,
      thumbS3Key: p.thumbS3Key,
    }));
}

async function buildMessages(
  loaded: LoadedPhotoBook,
  available: (AutoLayoutPhoto & { s3Key: string; thumbS3Key: string | null })[],
  languageName: string,
): Promise<ChatCompletionMessageParam[]> {
  const sections = computeCandidateSections(available);
  const clusterIndex = new Map<string, number>();
  sections.forEach((section, i) => section.forEach((p) => clusterIndex.set(p.assetId, i)));

  const visionIds = selectVisionImages(sections, MAX_VISION_IMAGES);

  const userParts: ChatCompletionContentPart[] = [
    {
      type: 'text',
      text:
        `Design the layout for "${loaded.row.title}" (${available.length} available photo${available.length === 1 ? '' : 's'}, grouped below into ${sections.length} candidate cluster${sections.length === 1 ? '' : 's'} by time/place — feel free to keep, merge, split, or rename these). ` +
        `You can see ${visionIds.size} of the photos as actual images below (the rest are described by metadata only — the strongest candidates by score were prioritized). Reply with the JSON layout plan only.`,
    },
    { type: 'text', text: `Available photos (${available.length}):\n${available.map((p) => photoTableLine(p, clusterIndex.get(p.assetId)!)).join('\n')}` },
  ];

  for (const photo of available) {
    if (!visionIds.has(photo.assetId)) continue;
    const dataUri = await encodePhotoForVision(photo);
    if (!dataUri) continue;
    userParts.push({ type: 'text', text: `Photo for assetId ${photo.assetId}:` });
    userParts.push({ type: 'image_url', image_url: { url: dataUri } });
  }

  return [
    { role: 'system', content: systemPrompt(languageName) },
    { role: 'user', content: userParts },
  ];
}

/** Strips markdown code fences and any leading/trailing prose, then parses the first
 *  balanced-looking JSON OBJECT found — identical tolerance to `extractJson` in
 *  `lib/book-ai-layout.ts` (duplicated rather than imported, see the module header: that
 *  file stays untouched). */
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
 * Post-processing carry-over (mirrors `applyPlanCarryOver` in `lib/book-ai-layout.ts`):
 * overrides the model's `style` with whatever plan was already stored, its
 * `cover.heroAssetId` with the book's pinned cover (`books.cover_asset_id`) when one is
 * set, and — since PR6's builder Step 2 config panel made front-cover title/subtitle
 * explicit, user-edited book settings (`books.title`/`books.subtitle`) rather than
 * something only the AI proposes — its `cover.title`/`cover.subtitle` too. The model
 * still gets asked for a title/subtitle in its JSON output (the schema requires one), but
 * the result here is always the book's own values: the design pass must never silently
 * override what the user typed into the config panel, only the section titles/pacing/hero
 * pick it actually has judgment to add. Mirrors `resolveUsableHeroId`'s "book settings win
 * over the plan" precedent for the hero id. Exported for testing.
 */
export function applyPhotoPlanCarryOver(plan: PhotoBookPlan, loaded: LoadedPhotoBook): PhotoBookPlan {
  const existing = loaded.row.layoutPlan ? validatePhotoBookPlan(loaded.row.layoutPlan) : null;
  const existingPlan = existing?.ok ? existing.plan : null;

  const style = existingPlan?.style ?? plan.style;
  const pinnedHero =
    loaded.row.coverAssetId && loaded.photos.some((p) => p.assetId === loaded.row.coverAssetId && !p.excluded)
      ? loaded.row.coverAssetId
      : null;
  const heroAssetId = pinnedHero ?? plan.cover.heroAssetId;

  const cover: PhotoBookPlan['cover'] = {
    ...plan.cover,
    // `heroAssetId` can only end up falsy here if `plan.cover.heroAssetId` already was
    // (pinnedHero is null and there's nothing to fall back to) — so leaving the spread
    // above as-is already covers that case; only the truthy case needs an override.
    ...(heroAssetId ? { heroAssetId } : {}),
    title: loaded.row.title,
  };
  if (loaded.row.subtitle) cover.subtitle = loaded.row.subtitle;
  else delete cover.subtitle;

  return { ...plan, style, cover };
}

/**
 * Runs the AI design pass for a photo book. Loads the book's current content, sends the
 * model the full photo analysis table plus a capped set of actual images, and returns a
 * validated `PhotoBookPlan` — or `null` on any failure, in which case the caller should
 * fall back to `buildAndPersistPhotoAutoPlan`. Never throws.
 */
export async function proposePhotoBookPlan(bookId: string): Promise<PhotoBookPlan | null> {
  try {
    const loaded = await loadPhotoBook(bookId);
    const available = toAutoLayoutPhotos(loaded.photos.filter((p) => !p.excluded));
    if (available.length === 0) {
      console.log(`[photo-book-ai-layout] design pass for ${bookId}: no available photos, skipping`);
      return null;
    }

    const languageName = await chronicleLanguageName(loaded.row.chronicleId);
    const messages = await buildMessages(loaded, available, languageName);

    const completion = await openrouter.chat.completions.create({
      model: env.STYLING_MODEL,
      messages,
      ...OPENROUTER_ROUTING,
    });

    const text = completion.choices[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) {
      console.error(`[photo-book-ai-layout] design pass for ${bookId} returned no content`);
      return null;
    }

    const parsed = extractJson(text);
    if (!parsed) {
      console.error(`[photo-book-ai-layout] design pass for ${bookId} returned unparseable JSON:`, text.slice(0, 500));
      return null;
    }

    const validated = validatePhotoBookPlan(parsed);
    if (!validated.ok) {
      console.error(`[photo-book-ai-layout] design pass for ${bookId} failed schema validation: ${validated.error}`);
      return null;
    }

    const plan = applyPhotoPlanCarryOver(validated.plan, loaded);

    // "Available" here means what `checkPhotoBookPlanConsistency` — and
    // `buildAndPersistPhotoAutoPlan`'s own `content.availableAssetIds` — mean by it:
    // every non-excluded photo, NOT further narrowed to `available` (which additionally
    // requires known dimensions, since only those can be shown to the model or laid
    // out). Using the narrower set here would make a pinned cover
    // (`books.cover_asset_id`, applied by `applyPhotoPlanCarryOver` above regardless of
    // whether its dimensions have been analyzed yet) look "unavailable" and needlessly
    // fail consistency — matching PR2's definition keeps the two producers agreeing on
    // what counts as in-bounds.
    const content: PhotoPlanContent = {
      availableAssetIds: loaded.photos.filter((p) => !p.excluded).map((p) => p.assetId),
      allAssetIds: loaded.photos.map((p) => p.assetId),
    };
    const problems = checkPhotoBookPlanConsistency(plan, content);
    if (problems.length > 0) {
      console.error(`[photo-book-ai-layout] design pass for ${bookId} failed consistency check:`, problems);
      return null;
    }

    // Completeness check for force-included photos (docs/PHOTO_BOOK_PLAN.md re-include
    // fix): unlike the deterministic auto-layouter, this is a model's free-form judgment
    // call, and HARD_RULES telling it a photo "MUST BE INCLUDED" is a strong hint, not a
    // guarantee — `checkPhotoBookPlanConsistency` above only verifies the model didn't
    // reference anything it shouldn't, not that it placed everything it was told to. A
    // force-included photo the model still left out breaks the "the user insisted"
    // contract just as much as an invalid plan would, so this is treated the same way:
    // discard and fall back to `buildAndPersistPhotoAutoPlan`, which — thanks to the same
    // `userDecision` threading in `lib/photo-book-autolayout.ts` — is guaranteed to place
    // every force-included photo somewhere.
    const forcedIncludeIds = available.filter((p) => p.userDecision === 'include').map((p) => p.assetId);
    if (forcedIncludeIds.length > 0) {
      const referenced = referencedPhotoAssetIds(plan);
      const missing = forcedIncludeIds.filter((id) => !referenced.has(id));
      if (missing.length > 0) {
        console.error(
          `[photo-book-ai-layout] design pass for ${bookId} omitted ${missing.length} force-included photo(s), discarding:`,
          missing,
        );
        return null;
      }
    }

    return plan;
  } catch (err) {
    console.error(`[photo-book-ai-layout] design pass for ${bookId} failed:`, err);
    return null;
  }
}
