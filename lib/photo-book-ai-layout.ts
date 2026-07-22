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
  groupingInstruction,
  parsePhotoGrouping,
  type PhotoBookGrouping,
} from '@/lib/photo-book-grouping';
import {
  checkPhotoBookPlanConsistency,
  validatePhotoBookPlan,
  PHOTO_BOOK_STYLES,
  PHOTO_PAGE_TEMPLATES,
  PHOTO_PAGE_TEMPLATE_SLOTS,
  photoBookPlanHasContent,
  photoOrientation,
  type PhotoBookPlan,
  type PhotoPlanContent,
} from '@/lib/photo-book-plan';
import { referencedPhotoAssetIds } from '@/lib/photo-book-content';
import { TRIM } from '@/lib/book-content';
import {
  formatLintFindings,
  lintPhotoBookPlan,
  lintScore,
  TEMPLATE_SHAPE_RULES,
  type LintPhoto,
  type PhotoBookLintFinding,
} from '@/lib/photo-book-lint';
import { coercePhotoBookPlan, repairPhotoBookPlan } from '@/lib/photo-book-repair';
import { flaggedPageIndices, planPageLabels, renderProofPages, selectProofPages } from '@/lib/photo-book-proof';
import type { PhotoBookDesignStage } from '@/lib/photo-book-design-stage';

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

/** The one shared definition (`lib/photo-book-plan.ts`), so the shape printed for each
 *  photo in the prompt is exactly the shape the design check will judge it by. */
function orientation(width: number, height: number): string {
  return photoOrientation({ width, height });
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
    'full-bleed': 'one photo filling the whole page inside the standard frame (slight crop to the page shape) — hero moments',
    'full-framed': 'one photo, matted with a frame, never cropped',
    'two-horizontal': 'two photos stacked as two full-width rows',
    'two-vertical': 'two photos side by side in one justified row',
    'three-column': 'three photos side by side in one justified row',
    'three-mixed': 'one dominant photo across the top + a justified pair below it',
    'four-mixed': 'one dominant photo across the top + a justified trio below it',
    'collage-4': 'four photos in two justified rows (2+2)',
    'collage-5': 'five photos in two justified rows (2+3)',
    'collage-6': 'six photos in two justified rows (3+3) — the densest page allowed',
    divider: '(never use this — see the hard rules)',
  };
  // The shape requirement printed here comes from `TEMPLATE_SHAPE_RULES`
  // (`lib/photo-book-lint.ts`) — the SAME table the finished plan is checked against, so
  // what the model is told can never drift from what it is judged by. `divider` is
  // excluded from the vocabulary on purpose: every section already gets its own
  // automatic title page, and a plan-emitted divider renders as a blank page (see
  // HARD_RULES) — production books were full of exactly those.
  return PHOTO_PAGE_TEMPLATES.filter((t) => t !== 'divider')
    .map((t) => {
      const { min, max } = PHOTO_PAGE_TEMPLATE_SLOTS[t];
      const arity = min === max ? `exactly ${min}` : `${min}-${max}`;
      const rule = TEMPLATE_SHAPE_RULES[t];
      const shape = rule ? ` — SHAPE: ${rule.why}` : ' — works with any photo shape';
      return `  "${t}" — ${arity} photo${max === 1 ? '' : 's'} — ${descriptions[t]}${shape}`;
    })
    .join('\n');
}

/**
 * The rule the design pass exists to enforce, stated as plainly as possible. Photo shape
 * ("landscape"/"portrait") is printed for every photo in the table below, so this is
 * something the model can actually act on — and the reason it matters is mechanical: a
 * side-by-side row gives every photo in it the SAME height, so the row's height is the page
 * width divided by the sum of the photos' aspect ratios. Three landscapes (≈1.5 each) come
 * out as a 1/4.5-of-the-width strip on a tall page. This paragraph is what stops that.
 */
const SHAPE_RULES = `Photo shape rules — these are the difference between a book that looks designed and one that looks broken. Every page renders its photos UNCROPPED at their true shapes, arranged in justified rows that share one height and fill the page width; leftover space frames the arrangement symmetrically. That means a page only looks good when the shapes you combine actually fill it — check every photo's shape (landscape / portrait / square, given in the photo list below) before you put photos on a page together:
- "three-column" places all three photos in ONE ROW at a shared height. Use it ONLY when all three photos are portrait. A single landscape photo in that row collapses the whole row into a thin horizontal strip with huge empty margins above and below — this is the single most common way this layout goes wrong.
- Any trio that contains a landscape photo must use "three-mixed" instead, with the LANDSCAPE photo listed FIRST (it becomes the dominant one across the top).
- "four-mixed" is the same idea for four photos: the FIRST photo spans the full width on top (must be landscape or square), the other three share the row below — the best way to combine one landscape with three portraits.
- "two-vertical" is the side-by-side row for pairs: right for two portraits, and fine for one portrait + one landscape. Two landscapes side by side become a strip — stack them with "two-horizontal" instead.
- "two-horizontal" renders both photos full-width, stacked. Both must be landscape (or square) — a portrait photo rendered full-width is taller than the page and forces everything to shrink.
- "full-framed" shows one photo matted and completely uncropped — safe for any shape. "full-bleed" fills the whole page area and crops slightly to the page's shape, so use it only for a photo whose shape roughly matches the page (and never when the crop would cut into faces).
- "collage-4"/"collage-5"/"collage-6" are justified mosaics — any mix of shapes works, but they read best when each row mixes orientations rather than stacking three landscapes.`;

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
- NEVER output an empty page: never use the "divider" template and never output a page with zero photos. Every section automatically gets its own full-page title divider — an extra one from you prints as a completely BLANK page in the finished book.
- A page's "assetIds" length must exactly match its template's photo count (see the template list).
- If "captions" is present on a page, it must have exactly as many entries as "assetIds".
- Any photo marked "[MUST BE INCLUDED — the user manually re-added this photo]" in the photo list below MUST appear somewhere in your plan (as the cover hero, a cover back photo, or on a section page) — never leave one of these out, no matter how weak/blurry/redundant it looks. This is a hard requirement, not a suggestion: a plan missing one of these photos is discarded just like an invalid one.
- Output ONLY the JSON object. No markdown code fences, no explanation before or after, nothing but the JSON.`;

/** Fetches the chronicle's story-language setting (`chronicles.story_language`) for a
 *  book — used to write section titles/captions in the family's language. Falls back to
 *  German, matching the auto-layouter's own `dateLocale` default (`'de-DE'`) and the
 *  app's German-first default locale. */
async function chronicleContext(chronicleId: string): Promise<{ languageName: string; name: string }> {
  const [row] = await db
    .select({ storyLanguage: chronicles.storyLanguage, name: chronicles.name })
    .from(chronicles)
    .where(eq(chronicles.id, chronicleId))
    .limit(1);
  return {
    languageName: row?.storyLanguage === 'en' ? 'English' : 'German',
    // Matches `renderPhotoBook`'s own fallback in `lib/book-render.ts` — the name only
    // appears as running text on the cover/divider pages of the proof render.
    name: row?.name ?? 'Familienwerk',
  };
}

/** What the candidate clusters in the prompt were grouped by, so the sentence introducing
 *  them matches the grouping the rest of the prompt asks for. */
const CLUSTER_BASIS: Record<PhotoBookGrouping, string> = {
  chronological: 'time and place',
  topic: 'shared subject matter',
  location: 'GPS proximity',
};

function systemPrompt(languageName: string, grouping: PhotoBookGrouping): string {
  return `You are an experienced photo-book designer working for "Familienwerk", a private family memoir app. You are given one family's photo book: every available photo's metadata (id, when/roughly where it was taken, a candidate cluster, its vision-analysis scores if available, and its pixel size) and, for the more important ones, the actual images. Your job is to propose a JSON "layout plan" (docs/PHOTO_BOOK_PLAN.md §5) that groups the photos into sections, gives each section a real title, picks a cover hero, and lays every section out page by page.

How this book is to be organised — the reader chose this themselves in the app, so it is a requirement, not a suggestion:
${groupingInstruction(grouping)}

${schemaText()}

${SHAPE_RULES}

${HARD_RULES}

Design goals — this is where your judgment (and the ability to actually see the photos) matters, and is the entire reason this pass exists instead of a mechanical date-range layout:
- NAME sections from what's actually in them ("Am Strand", "Omas Geburtstag") rather than a generic date range — put the date range in "dateLabel" instead if you want to keep it visible.
- Follow the organisation the reader chose (stated at the top) when deciding what belongs in a section and in what order the sections run. Everything below is about how each section then LOOKS.
- Pick the cover hero: prefer a photo whose analysis marks it "coverCandidate", and among those the highest "aestheticScore" — a warm, clear, well-composed photo of people, not a blurry or eyes-closed one. The cover's title/subtitle text is fixed by the user's own settings and not yours to change — spend your judgment on the hero pick instead.
- LESS IS MORE. Professional photo books put 1-3 photos on most pages and never more than 6; a dense mosaic page is the exception that makes the strong single-photo pages land, not the norm. When in doubt, give a photo more room, not less.
- SHOW PHOTOS WHOLE. The layout never crops (except "full-bleed"'s slight fit-to-page) — your job is to pick shape combinations that fill each page pleasantly (see the shape rules above). Pair and group photos whose orientations complement each other: a landscape over two portraits, two portraits side by side, mixed rows. White space around a well-shaped arrangement is a design feature; a photo squashed into a thin strip is not.
- ONE DOMINANT PHOTO PER PAGE-GROUP. On multi-photo pages prefer the "*-mixed" templates, which give the best photo of the moment clear visual priority; two or three equally-sized photos are fine, but five equal tiles on every page reads as a contact sheet.
- Vary the rhythm across sections — don't give every section the identical page pattern, and alternate density: after a dense multi-photo page, let a strong single-photo page breathe. A section opener is usually its own strong single-photo page; some sections can build to another strong single-photo page mid-way; others stay all multi-photo pages. A book that "breathes" differently section to section reads as designed, not generated.
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
  grouping: PhotoBookGrouping,
): Promise<ChatCompletionMessageParam[]> {
  // The candidate clusters are computed the SAME way the user asked the book to be
  // organised, so the starting point the model is given already agrees with the
  // instruction it is being held to.
  const sections = computeCandidateSections(available, grouping);
  const clusterIndex = new Map<string, number>();
  sections.forEach((section, i) => section.forEach((p) => clusterIndex.set(p.assetId, i)));

  const visionIds = selectVisionImages(sections, MAX_VISION_IMAGES);

  const userParts: ChatCompletionContentPart[] = [
    {
      type: 'text',
      text:
        `Design the layout for "${loaded.row.title}" (${available.length} available photo${available.length === 1 ? '' : 's'}, grouped below into ${sections.length} candidate cluster${sections.length === 1 ? '' : 's'} by ${CLUSTER_BASIS[grouping]} — feel free to keep, merge, split, or rename these). ` +
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
    { role: 'system', content: systemPrompt(languageName, grouping) },
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
 * Turns a model's raw reply into a plan that is guaranteed valid, consistent with the
 * book's current photos, and complete (every force-included photo placed) — or `null` if
 * the reply had nothing plan-shaped in it at all.
 *
 * This function is why the design pass stopped being all-or-nothing. Previously each of
 * these steps was a `return null` (→ silent fall back to the mechanical auto-layout), which
 * is what production books were actually getting: one duplicated assetId or one miscounted
 * page and the user's "Buch erstellen" click produced a plain date-range layout that they
 * then judged the AI by. Now the model's judgment — the sections, the titles, the pacing,
 * the hero — is kept, and only the mechanical defects are fixed.
 */
function acceptPlan(
  bookId: string,
  raw: unknown,
  loaded: LoadedPhotoBook,
  available: (AutoLayoutPhoto & { s3Key: string; thumbS3Key: string | null })[],
  label: string,
): PhotoBookPlan | null {
  // Only a fallback for a model that omitted/invented a `style` — `applyPhotoPlanCarryOver`
  // below overrides it with the stored plan's style regardless (the user's own choice wins).
  const stored = loaded.row.layoutPlan ? validatePhotoBookPlan(loaded.row.layoutPlan) : null;

  const coerced = coercePhotoBookPlan(raw, {
    photos: available,
    fallbackTitle: loaded.row.title,
    fallbackStyle: stored?.ok ? stored.plan.style : 'classic',
  });
  if (!coerced) {
    console.error(`[photo-book-ai-layout] ${label} for ${bookId}: reply had no usable plan structure`);
    return null;
  }

  const repaired = repairPhotoBookPlan(coerced.plan, {
    photos: available,
    mustInclude: available.filter((p) => p.userDecision === 'include').map((p) => p.assetId),
  });
  const fixes = [...coerced.changes, ...repaired.changes];
  if (fixes.length > 0) {
    console.log(`[photo-book-ai-layout] ${label} for ${bookId}: repaired ${fixes.length} defect(s):`, fixes);
  }

  const plan = applyPhotoPlanCarryOver(repaired.plan, loaded);

  // Last line of defence. `coerce` + `repair` are built to make this pass, so a failure
  // here is a bug in them, not a model problem — log it loudly and let the caller fall
  // back rather than persisting something the renderer can't trust.
  //
  // "Available" means what `checkPhotoBookPlanConsistency` — and
  // `buildAndPersistPhotoAutoPlan`'s own `content.availableAssetIds` — mean by it: every
  // non-excluded photo, NOT further narrowed to `available` (which additionally requires
  // known dimensions). Using the narrower set would make a pinned cover
  // (`books.cover_asset_id`, applied by `applyPhotoPlanCarryOver` regardless of whether its
  // dimensions have been analyzed yet) look "unavailable" and needlessly fail.
  const content: PhotoPlanContent = {
    availableAssetIds: loaded.photos.filter((p) => !p.excluded).map((p) => p.assetId),
    allAssetIds: loaded.photos.map((p) => p.assetId),
  };
  const validated = validatePhotoBookPlan(plan);
  if (!validated.ok) {
    console.error(`[photo-book-ai-layout] ${label} for ${bookId} failed schema validation after repair: ${validated.error}`);
    return null;
  }
  const problems = checkPhotoBookPlanConsistency(validated.plan, content);
  if (problems.length > 0) {
    console.error(`[photo-book-ai-layout] ${label} for ${bookId} failed consistency check after repair:`, problems);
    return null;
  }
  // A carried-over pinned cover hero (`applyPhotoPlanCarryOver`) can displace a
  // force-included photo that repair had placed on page one. Cheap to re-check, and the
  // "the user insisted" contract is worth being sure about.
  const referenced = referencedPhotoAssetIds(validated.plan);
  const missing = available
    .filter((p) => p.userDecision === 'include')
    .map((p) => p.assetId)
    .filter((id) => !referenced.has(id));
  if (missing.length > 0) {
    console.error(`[photo-book-ai-layout] ${label} for ${bookId} still omits force-included photo(s):`, missing);
    return null;
  }

  // An empty plan is legal — `checkPhotoBookPlanConsistency` doesn't even require a cover
  // hero once there's no content to cover — but it is not a BOOK. If the model referenced
  // nothing usable (hallucinated ids, or every photo it named has since been excluded),
  // coerce+repair correctly reduce that to zero sections, and without this check the worker
  // would persist those zero sections as `layout_source: 'ai'` with `generated_at` stamped:
  // the user clicks "Buch erstellen" and gets a front cover, a back cover, and nothing in
  // between, while the auto layout that would have produced a real book is never reached.
  // Treat it as "no usable plan" so the caller falls back.
  if (!photoBookPlanHasContent(validated.plan)) {
    console.error(`[photo-book-ai-layout] ${label} for ${bookId} placed no photos at all — treating as unusable`);
    return null;
  }

  return validated.plan;
}

/** The photo shapes + scores the linter needs, straight off the rows already loaded. */
function toLintPhotos(photos: AutoLayoutPhoto[]): LintPhoto[] {
  return photos.map((p) => ({ assetId: p.assetId, width: p.width, height: p.height, analysis: p.analysis }));
}

const REVIEW_SYSTEM_PROMPT = `You are the same photo-book designer, now reviewing your own finished layout. You are shown: the layout plan you produced, an automated design check listing concrete problems found in it, and SCREENSHOTS OF THE ACTUAL RENDERED PAGES.

Look at the rendered pages. Judge them the way a person flipping through the printed book would:
- Is any page BLANK or nearly blank? A blank page must never survive review — delete it (a photo-less "divider" page is the usual culprit; every section already gets its real title page automatically).
- Is any row of photos squashed into a thin strip with big empty margins above and below it? (That is what happens when landscape photos are put in a side-by-side row — the fix is a different template, not a different photo size.)
- Does a page look lopsided or half-empty, or has an arrangement shrunk into a small centered block because its photo shapes don't fill the page? Pick a template that suits those shapes instead.
- Do several pages in a row look identical, so the book reads as mechanically generated? Are there too many equal-tiled mosaic pages where one photo should dominate?
- Is anything important cropped out (a face cut off by a "full-bleed" page's fit-to-page crop)?

Then output a CORRECTED version of the complete layout plan, in exactly the same JSON format, fixing every problem you can. Keep everything that already works — the section boundaries, the titles, the cover hero, the captions — and change only what needs changing. It is fine to move a photo to a different page, swap a page's template, split or merge pages, or drop a weak photo.

Output ONLY the corrected JSON plan. No markdown fences, no commentary before or after.`;

/** Builds the review round's user message: the current plan, the deterministic findings,
 *  and the rendered pages themselves. */
function buildReviewMessages(
  plan: PhotoBookPlan,
  findings: PhotoBookLintFinding[],
  proofs: { index: number; label: string; dataUri: string }[],
  available: (AutoLayoutPhoto & { s3Key: string })[],
  languageName: string,
  clusterIndex: Map<string, number>,
  grouping: PhotoBookGrouping,
): ChatCompletionMessageParam[] {
  const parts: ChatCompletionContentPart[] = [
    {
      type: 'text',
      text:
        // Restated here so a revision can't quietly reorganise a by-topic book back into a
        // timeline: this message is a fresh conversation, the model has no memory of the
        // draft round's system prompt.
        `The reader's chosen organisation for this book, unchanged:\n${groupingInstruction(grouping)}\n\n` +
        `Here is the layout plan you produced:\n\n${JSON.stringify(plan)}\n\n` +
        (findings.length > 0
          ? `An automated design check found these problems:\n${formatLintFindings(findings)}\n\n`
          : 'The automated design check found no problems, but it only catches mechanical faults — judge the pages yourself.\n\n') +
        `Below are screenshots of ${proofs.length} of the rendered pages. Fix what you see and output the corrected full plan. Titles and captions stay in ${languageName}. You may only use assetIds from this list:`,
    },
    {
      type: 'text',
      text: `Available photos (${available.length}):\n${available
        .map((p) => photoTableLine(p, clusterIndex.get(p.assetId) ?? 0))
        .join('\n')}`,
    },
  ];
  for (const proof of proofs) {
    parts.push({ type: 'text', text: `Rendered ${proof.label}:` });
    parts.push({ type: 'image_url', image_url: { url: proof.dataUri } });
  }
  return [
    { role: 'system', content: REVIEW_SYSTEM_PROMPT },
    { role: 'user', content: parts },
  ];
}

export interface ProposePhotoBookPlanOptions {
  /** Called as the pass moves between stages, so the worker can publish progress to the
   *  builder (`books.design_stage`). Failures here are swallowed by the caller. */
  onStage?: (stage: PhotoBookDesignStage) => Promise<void> | void;
  /** Set false to skip the render+review round entirely (one model call instead of two,
   *  no Chromium). Only used to keep the pass cheap where a review can't help. */
  review?: boolean;
}

/**
 * Runs the AI design pass for a photo book:
 *
 *  1. **draft** — the model sees every photo's metadata plus a capped set of actual images
 *     and proposes a full layout plan;
 *  2. **repair** — the reply is parsed leniently and mechanically fixed (`acceptPlan`);
 *  3. **proof** — the draft is rendered and its pages screenshotted (`lib/photo-book-proof.ts`);
 *  4. **review** — the model looks at its own rendered pages plus a deterministic design
 *     check (`lib/photo-book-lint.ts`) and returns a corrected plan;
 *  5. **keep the better one** — the revision is only adopted if it actually scores better
 *     on the same design check, so a review round can never make a book worse.
 *
 * Returns the plan, or `null` if there's nothing usable at all, in which case the caller
 * falls back to `buildAndPersistPhotoAutoPlan`. Never throws.
 */
export async function proposePhotoBookPlan(
  bookId: string,
  options: ProposePhotoBookPlanOptions = {},
): Promise<PhotoBookPlan | null> {
  const stage = async (s: PhotoBookDesignStage) => {
    try {
      await options.onStage?.(s);
    } catch (e) {
      console.warn(`[photo-book-ai-layout] stage report '${s}' failed for ${bookId}:`, e);
    }
  };

  try {
    await stage('preparing');
    const loaded = await loadPhotoBook(bookId);
    const available = toAutoLayoutPhotos(loaded.photos.filter((p) => !p.excluded));
    if (available.length === 0) {
      console.log(`[photo-book-ai-layout] design pass for ${bookId}: no available photos, skipping`);
      return null;
    }

    const { languageName, name: chronicleName } = await chronicleContext(loaded.row.chronicleId);
    const grouping = parsePhotoGrouping(loaded.row.photoGrouping);
    const messages = await buildMessages(loaded, available, languageName, grouping);

    await stage('drafting');
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

    const draft = acceptPlan(bookId, extractJson(text), loaded, available, 'draft');
    if (!draft) return null;
    if (options.review === false) return draft;

    const lintPhotos = toLintPhotos(available);
    const draftFindings = lintPhotoBookPlan(draft, lintPhotos);
    const draftScore = lintScore(draftFindings);

    // Render the draft and let the model look at it. A failure anywhere in here leaves the
    // draft standing — the review is an improvement pass, never a gate.
    await stage('proofing');
    const trim = TRIM[loaded.row.format] ?? TRIM['hardcover-21x28'];
    const { labels } = planPageLabels(draft);
    const wanted = selectProofPages(labels, flaggedPageIndices(draft, draftFindings));
    const proofs = await renderProofPages(loaded, draft, chronicleName, trim, wanted);
    if (proofs.length === 0) {
      console.log(`[photo-book-ai-layout] design pass for ${bookId}: no proof pages rendered, keeping the draft`);
      return draft;
    }

    await stage('reviewing');
    const clusterIndex = new Map<string, number>();
    computeCandidateSections(available, grouping).forEach((section, i) =>
      section.forEach((p) => clusterIndex.set(p.assetId, i)),
    );
    const reviewCompletion = await openrouter.chat.completions.create({
      model: env.STYLING_MODEL,
      messages: buildReviewMessages(draft, draftFindings, proofs, available, languageName, clusterIndex, grouping),
      ...OPENROUTER_ROUTING,
    });
    const reviewText = reviewCompletion.choices[0]?.message?.content;
    if (typeof reviewText !== 'string' || !reviewText.trim()) {
      console.log(`[photo-book-ai-layout] review round for ${bookId} returned nothing, keeping the draft`);
      return draft;
    }

    await stage('finalizing');
    const revised = acceptPlan(bookId, extractJson(reviewText), loaded, available, 'review');
    if (!revised) return draft;

    const revisedScore = lintScore(lintPhotoBookPlan(revised, lintPhotos));
    if (revisedScore > draftScore) {
      console.log(
        `[photo-book-ai-layout] review round for ${bookId} scored worse (${revisedScore} vs ${draftScore}) — keeping the draft`,
      );
      return draft;
    }
    console.log(`[photo-book-ai-layout] review round for ${bookId} improved the design (${draftScore} → ${revisedScore})`);
    return revised;
  } catch (err) {
    console.error(`[photo-book-ai-layout] design pass for ${bookId} failed:`, err);
    return null;
  }
}
