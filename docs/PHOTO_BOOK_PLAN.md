# Photo Books — fully automatic photo-first books

A second, standalone book type next to the existing story book: the user dumps **100+ photos**
into the app, and Familienwerk does everything else — analyzes every photo (content, quality,
eyes closed, aesthetics, EXIF time/place), sorts and groups them chronologically, drops the
duds and near-duplicates, lays them out across varied page templates (full-bleed hero, 2-up,
3-column, collages…), applies one of a handful of fully-designed **style suites** (cover front
+ back, fonts, colors — no pick-your-own-font customization), and shows a live preview. The
user refines by chatting — **typed or by voice message** — and the v1 output is a **PDF**
(the print/order APIs stay parked, same as story books).

The core promise: **automate the part families hate** — sorting hundreds of photos, spotting
the good ones, clicking a layout together page by page. One upload, one "design my book"
click, one great default.

This builds directly on the existing book stack (layout-plan-as-data, auto-layouter → AI
pass → validation → fallback, live Paged.js HTML preview, Chromium print render, book-scoped
chat agent). Read `docs/BOOK_FEATURE_PLAN.md` and `docs/BOOK_LAYOUT_PLAN.md` first; this plan
only spells out what's *new or different*.

---

## 1. User journey

1. **Entry** — `/books` → "Create book" now asks: **Story book** (existing flow) or
   **Photo book** (new).
2. **Upload** — a bulk uploader built for 100–300 photos: multi-select (on iOS this picker
   *is* the iCloud photo library — see §10), parallel direct-to-S3 uploads with per-file
   progress and retry. Client reads EXIF (capture time, GPS) up front so the grid can
   already show a rough chronological order while uploads finish.
3. **Analyze** — the worker fingerprints and scores every photo (EXIF, perceptual hash,
   AI vision: aesthetics, sharpness, closed eyes, what's in it). A progress bar
   ("87 / 142 photos analyzed") runs while the user picks a style.
4. **Style** — the user picks one of up to 10 **style suites** from visual swatches.
   A suite is a complete design (cover front/back, fonts, palette, frames, dividers) —
   deliberately *not* customizable beyond picking a different suite.
5. **Generate** — one click: the deterministic auto-layouter produces a complete book
   instantly; the AI design pass refines it in the background (hero picks, pacing,
   section titles, captions) — same producer pattern as story books.
6. **Preview & refine** — live HTML preview (Paged.js), instant updates. Refinement is
   chat-first: the embedded book chat accepts **text and voice messages** ("mach das
   Strandfoto größer", "die verschwommenen raus", "nenn das erste Kapitel 'Sommer in
   Italien'"). A small set of direct controls (hide photo, make full page, reorder
   sections) exists for one-tap fixes.
7. **Output** — **Download PDF** (full-resolution, unwatermarked print PDF). The order
   screen (Gelato quote + mailto) is reused as-is; payment/print submission stay parked.

## 2. Data model (`db/schema.ts`)

### Book kind

```ts
export const bookKind = pgEnum('book_kind', ['story', 'photo']);
// books table: + kind: bookKind('kind').notNull().default('story')
```

One `books` table for both kinds — status lifecycle, format, cover asset, `layout_plan` /
`layout_source` / `layout_stale`, `design_requested_at`, preview/print S3 keys, and the
order tables all apply unchanged. `book_stories` simply stays empty for photo books.

### Asset ownership

Today `assets.story_id` is NOT NULL — every photo belongs to a story. Photo-book uploads
belong to a **book**, not a story:

```ts
// assets: story_id becomes nullable; add
bookId: uuid('book_id').references(() => books.id, { onDelete: 'cascade' }),
// CHECK (story_id IS NOT NULL OR book_id IS NOT NULL)
```

Rationale: reusing `assets` (not a parallel table) means the thumbnail job, HEIC decoding,
upload validation/presigning, and the orphan sweeper keep working with only small touches:

- new upload prefix `books/photos/` added to `SWEPT_PREFIXES` in `lib/orphans.ts`
  (the sweeper already checks `assets.s3_key`/`thumb_s3_key` regardless of owner);
- every query that assumes `assets.story_id` is non-null gets audited (story pages filter
  by `storyId` anyway, so photo-book assets are invisible to them by construction).

### Per-photo book state + analysis

```ts
export const photoAnalysisStatus = pgEnum('photo_analysis_status', [
  'pending', 'analyzing', 'done', 'failed',
]);

export const bookPhotos = pgTable('book_photos', {
  id: uuid().defaultRandom().primaryKey(),
  bookId: uuid().notNull().references(() => books.id, { onDelete: 'cascade' }),
  assetId: uuid().notNull().references(() => assets.id, { onDelete: 'cascade' }),
  /** Upload order — the fallback sort when EXIF has no capture time. */
  position: integer().notNull(),
  /** Excluded from the layout (auto: duplicate/blurry/eyes-closed, or user says so).
   *  Excluded ≠ deleted: the tray in the builder shows them and they can be re-included. */
  excluded: boolean().notNull().default(false),
  excludedReason: text(), // 'duplicate' | 'blurry' | 'eyes-closed' | 'low-quality' | 'user'
  /** EXIF capture metadata, extracted server-side (authoritative). */
  takenAt: timestamp(),
  gpsLat: doublePrecision(),
  gpsLng: doublePrecision(),
  /** Perceptual hash (dHash, hex) for near-duplicate clustering — pure code, no AI. */
  phash: text(),
  analysisStatus: photoAnalysisStatus().notNull().default('pending'),
  /** AI vision result — see PhotoAnalysis in lib/photo-analysis.ts:
   *  { aestheticScore, sharpness, eyesClosed, peopleCount, sceneTags[],
   *    shortDescription, coverCandidate } */
  analysis: jsonb(),
  createdAt / updatedAt,
}, (t) => [uniqueIndex().on(t.bookId, t.assetId), index().on(t.bookId)]);
```

Hot fields (`takenAt`, `phash`, `excluded`) are real columns so the layouter and dedup can
query them; the model's judgment lives in the `analysis` jsonb blob.

Access: photo books follow `memberships` like everything else. The story-access kinship
gating (`docs/STORY_ACCESS_PLAN.md`) does **not** apply — these photos belong to the book,
not to stories; every chronicle member with access to the book sees them.

## 3. Bulk ingestion (100+ photos)

The single-photo presign flow (`lib/uploads.ts`, story photo actions) scales up with:

- **Batch presign** server action: one round trip signs N uploads (validated per file
  against the existing allowlist/15 MB limit); creates `assets` (kind `photo`,
  `book_id` set) + `book_photos` rows and enqueues per-photo jobs on completion.
- **Client upload manager** (`components/bulk-photo-uploader.tsx`): concurrency ~5,
  per-file retry with backoff, overall progress ("112 / 142 hochgeladen"), works through
  a several-hundred-file selection without blowing memory (sequential `File` reads).
  Mobile-first: this is the screen iPhone users will feed from their camera roll.
- **Client EXIF peek** (`exifr`, ~10 KB for the subset we need): capture time + GPS read
  in the browser and sent with the presign request, so ordering appears immediately.
  The worker re-extracts EXIF server-side from the original as the authoritative value
  (client values are hints; HEIC parsing in-browser is spotty).
- Uploads land under `books/photos/`; the existing `thumbnail` job runs per photo.

No resumable-upload protocol (tus etc.) in v1 — per-file retry over presigned PUTs is
plenty for 15 MB objects, and it's what already exists.

## 4. Analysis pipeline (worker)

Two new pg-boss queues (`lib/queue.ts`):

**`photo-meta` (per photo, cheap, deterministic)** — runs immediately after upload:
sharp metadata → oriented `width`/`height` on `assets`; EXIF → `takenAt`, `gpsLat/Lng`;
dHash over a 9×8 grayscale downscale (sharp raw pixels, ~20 lines, no dependency) →
`phash`. Fast enough to run with normal worker concurrency.

**`photo-vision` (batched, AI)** — vision scoring via OpenRouter (`VISION_MODEL`, same
client as `lib/book-ai-layout.ts`): batches of **~10 thumbnails per request** (768 px
JPEG data-URIs, exactly the `photoVisionDataUri` approach that already exists), one
structured-JSON answer per photo:

```ts
interface PhotoAnalysis {
  aestheticScore: number;   // 0–10: composition, light, moment
  sharpness: 'sharp' | 'soft' | 'blurry';
  eyesClosed: boolean;      // any clearly-closed eyes on a people photo
  peopleCount: number;
  sceneTags: string[];      // 'beach', 'birthday', 'group photo', 'food', …
  shortDescription: string; // one sentence, used for captions + agent context
  coverCandidate: boolean;
}
```

Each batch job validates per-photo JSON (zod), writes `book_photos.analysis`, and marks
`analysisStatus`. A failed batch retries via pg-boss; photos that still fail are marked
`failed` and simply layout without scores (treated as average). The scoring batches use
their own `VISION_MODEL` env (flash-lite tier) rather than `STYLING_MODEL` — see the
cost evaluation below.

### Cost & model strategy (evaluated)

Vision scoring is the only per-photo AI step, so it's where cost scales — and at current
prices it's a non-issue if the model tier is chosen deliberately:

- **Flash-lite-class hosted models** (Gemini Flash-Lite, Qwen-VL-Plus, 4o-mini class via
  OpenRouter) charge ~$0.10–0.15/M input; a 768 px image costs ~260–1100 tokens →
  **~$0.0001–0.0002 per photo, i.e. ~1–2 cents per 100-photo book** including prompt and
  JSON output. Even 1,000 books/month ≈ €20. Frontier-class models would be 20–50× that
  for no gain on "score this photo 0–10" — so the scoring batches get their **own
  `VISION_MODEL` env** (flash-lite tier) instead of reusing `STYLING_MODEL`, which stays
  the knob for the per-book design pass where judgment quality actually matters.
- **Self-hosted specialized models** (near-zero marginal cost) were evaluated as the
  alternative: LAION-Aesthetics / Aesthetic-Predictor-v2.5 (CLIP/SigLIP + small head,
  ONNX on CPU, ~0.5–1 s/photo on the VPS) for aesthetics, MediaPipe Face Landmarker
  (eye-blink blendshapes) for closed eyes, CLIP zero-shot for tags. Verdict: **not for
  v1** — it adds ONNX plumbing, ~0.5–1 GB of model weights to the worker image, and RAM
  pressure on the shared Hetzner VPS to save single-digit cents per book, and it still
  can't produce the `shortDescription` the captions/agent need. The `PhotoAnalysis`
  shape is deliberately producer-agnostic so a self-hosted scorer can replace the API
  call later without touching consumers — the reasons to do that are **DSGVO posture**
  (every photo leaves the server; today only the design pass's capped ~30 do) and volume,
  not cost.
### Turnaround & throughput (hosted route)

Latency is *not* a problem on the hosted route, for one structural reason: the worker's
vision jobs are **I/O-bound HTTP calls, not CPU work on our VPS** — the provider's fleet
does the compute, and we fan many requests out concurrently. (The self-hosted 0.5–1 s/photo
figure was serial CPU on *our* box — exactly what doesn't scale to hundreds of users, and
the reason we're not doing it in v1.)

The math on a flash-lite model (TTFT ~0.3 s, ~220–390 output tok/s):
- **One batch** (~6–8 thumbnails, structured JSON out ~120 tokens/photo ≈ ~850 output
  tokens): ≈ **3–5 s** wall-clock.
- **One book** (100 photos ≈ 14 batches): batches are enqueued independently and fanned
  out through the worker's concurrency (the pg-boss `photo-vision` queue), so they don't
  run serially — a whole book's vision pass lands in **~10–25 s** depending on the
  concurrency cap and provider rate limits, not 14×5 s.
- **Perceived latency ≈ 0 regardless**: the deterministic metadata layout (§6) gives the
  user a complete, viewable book the instant uploads finish (EXIF order + blur/dup culling,
  no AI). Vision only *refines* it (better hero, culling of eyes-closed shots, captions),
  arriving a few seconds later as a live-preview update. Nobody watches a spinner waiting
  on the model.

**Scaling to 10s–100s of concurrent users** shifts the bottleneck off latency and onto
throughput limits, handled by:
- **Provider rate limits (RPM/TPM)** are the real ceiling — request a higher tier, and use
  OpenRouter's provider routing to spread load across backends for the same model.
- **Worker fan-out + replicas**: `photo-vision` runs at a healthy concurrency (dozens of
  in-flight HTTP calls per worker, since they're not CPU-bound); if book volume outgrows
  one worker, the process scales horizontally (stateless, pulls from the shared pg-boss
  queue) without touching the web tier.
- **Graceful degradation**: because the metadata book already stands, a backed-up vision
  queue never blocks a user — their book just gets its AI refinement a bit later. A batch/
  async vision API (≈50% cheaper, minutes-scale) is a possible cost lever at high volume,
  but its latency is wrong for the interactive refine, so v1 stays on real-time calls.

- **Dedicated vision APIs** (AWS Rekognition face-quality/eyes-open at ~$1/1,000 images,
  Google Cloud Vision) cost ~10× the LLM route, cover fewer fields, and add a vendor —
  rejected.
- **What never needs a model**: blur detection moves to the free tier — variance of
  Laplacian over sharp's raw pixels in the `photo-meta` job — alongside pHash dedup and
  EXIF. The vision call then only judges what actually needs judgment (aesthetics, eyes,
  content); if flash-lite eyes-closed detection proves unreliable on small faces in
  group shots, MediaPipe face landmarks slot into `photo-meta` as a fast-follow.

**Duplicate clustering** is pure code at layout time (not a job): photos whose phash
Hamming distance ≤ threshold within the same time cluster form a group; the best
`aestheticScore` wins, the rest get `excluded: 'duplicate'`.

**Location labels**: v1 groups by GPS *proximity* (cluster centroids) without naming
places — no geocoding dependency. A section falls back to its date range ("Juni 2025")
as title until the AI pass names it from photo content ("Am Strand"). Offline reverse
geocoding (e.g. a bundled coarse cities dataset) is an open decision, not a blocker.

## 5. Photo-book layout plan (`lib/photo-book-plan.ts`)

A new plan schema, stored in the same `books.layout_plan` column, discriminated by the
book's `kind`. Same philosophy as v1: **layout is data**; every producer (auto, AI, chat
edit) writes this shape, one renderer consumes it, `checkPlanConsistency` gates it.

```ts
{
  kind: 'photo',
  style: 'classic' | 'modern' | …,        // style suite id (§7)
  cover: {
    heroAssetId, title, subtitle?,        // front
    backAssetIds?: string[],              // back: 0–3 small photos + suite design
  },
  sections: [{                            // a chapter of the book
    title: string,                        // "Sommer in Italien" / "Juni 2025"
    dateLabel?: string,
    pages: [{ template, assetIds, captions? }],
  }],
}
```

**Page templates** (the fixed layout vocabulary the AI chooses from — mirrors the block
vocabulary of story books):

| template | photos | use |
|---|---|---|
| `full-bleed` | 1 | hero moments; photo fills the whole content box (slight fit-to-page crop) inside the shared page frame |
| `full-framed` | 1 | one photo, matted per the style suite (v1's `photo-page`) |
| `two-horizontal` | 2 | two landscapes stacked as full-width rows |
| `two-vertical` | 2 | two portraits side by side in one justified row |
| `three-column` | 3 | three portraits in one justified row |
| `three-mixed` | 3 | one dominant landscape across the top + a justified pair below |
| `four-mixed` | 4 | one dominant landscape across the top + a justified trio below |
| `collage-4` / `collage-5` / `collage-6` | 4–6 | justified mosaic rows (2+2 / 2+3 / 3+3), aspect-ratio aware |
| `divider` | 0–1 | legacy/edit-time only: never emitted by the AI pass (the section's title page is automatic; a photo-less divider renders blank and is swept away before persisting) |

Every multi-photo template renders as a **justified row stack** (`rowStackHtml`,
`lib/photo-book-layout.ts`): within a row every photo shares one height at its true
aspect ratio, rows fill the content-box width, and a stack that would overflow scales
down (photos are never cropped — only `full-bleed` crops, slightly, by design). All
photo pages share one constant page frame (`PHOTO_BOOK_CONTENT_MARGIN_MM`); only the
covers and section dividers bleed edge-to-edge.

**Unified-book text (PR B of the unification plan):** `section.pages` may also hold
`{ template: 'text', from, to }` flow items — inclusive paragraph ranges of the
section's `storyId` (a `book_stories` chapter with `include_text`). Text is NOT a fixed
sheet: it renders as a `.text-flow` on the document's single named `@page text-flow`
(real margins + the folio margin box; photo pages stay on the margin-0 default page and
are numberless by construction) and flows across as many pages as it needs —
spike-validated in both Chromium print and Paged.js. Consistency rules: exactly one
section per book story, text only in `storyId` sections, paragraphs 0..n-1 covered
exactly once in order (`checkPhotoBookPlanConsistency` with `content.stories`;
`repairTextCoverage` fixes broken coverage mechanically). Suite tokens for body
typography (size, leading, paragraph gap, drop cap, justify, folio style) live in
`lib/photo-book-styles.ts`. A TOC page is emitted iff any section carries a `storyId` —
pure photo books render exactly as before.

Validation (`validatePhotoBookPlan` + consistency check against `book_photos`): template
slot counts match, every referenced asset exists and isn't excluded, no photo appears
twice, every section non-empty. Same invalid-plan-falls-back-to-auto contract as v1.

## 6. Producers: auto-layouter + AI design pass

**`lib/photo-book-autolayout.ts` (deterministic, instant, free)** — the moment analysis
of *metadata* is done (vision can still be running), the user has a complete book:

1. Order by `takenAt` (fallback: upload `position`).
2. **Sectioning**: split on time gaps (> ~8h or a date change, tuned so a weekend trip
   stays one section) and large GPS jumps; merge tiny sections into neighbors; cap
   section count relative to book size.
3. **Culling**: exclude phash-duplicates (keep best score), `blurry`, `eyesClosed` on
   photos with a sharp-eyed sibling in the same cluster, and — if the user uploaded far
   more photos than the format prints well — the lowest-scored surplus. Everything
   excluded is visible in the builder's tray with its reason, one tap to re-include.
4. **Pacing**: per section, best-scored photo → `full-bleed` or `full-framed` opener;
   remaining photos grouped by aspect-ratio compatibility into 2-/3-/collage templates,
   ~2–4 photos per page, never a lone small photo swimming in white space (the v1
   fill-the-page rules carry over).
5. Cover hero = best `coverCandidate`/score in the book; before vision finishes,
   highest-resolution people photo.

**`design-photo-book` job (AI pass)** — mirrors `lib/book-ai-layout.ts` exactly (never
throws, silent fallback to auto, `design_requested_at` tracks in-flight, carry-over
preserves the user's pinned style/cover): the model receives the full analysis table
(id, time, place cluster, score, flags, description — *cheap text for all photos*) plus
actual vision images for the top ~40 candidates, and proposes the complete plan:
section boundaries and **titles**, hero picks, template rhythm, optional short
**captions** (from `shortDescription`, rewritten in the chronicle's language), cover
title suggestion. Validated + consistency-checked; on any failure the auto plan stands.

### 6b. "How should this book be organised?" (`books.photo_grouping`)

Sectioning used to be one fixed idea — split the timeline on time/GPS gaps. But the same
200 photos are a travel diary, a book of occasions, or a book of places depending on a
decision only the owner can make, so it's now theirs: a three-way choice in the builder's
config panel, made **before** generating (`lib/photo-book-grouping.ts`, default
`chronological` — what every existing book already is).

It feeds both producers, not just the prompt. `computeCandidateSections(photos, grouping)`
does the clustering:

- **chronological** — unchanged: time gaps > 8h, GPS jumps > 50km, adjacent-only merging.
- **location** — greedy clustering against running centroids (25km radius), so a week in
  one place is one section and a place revisited months later rejoins its own section
  rather than starting a new one. Photos with no EXIF GPS get a trailing section.
- **topic** — each photo joins the cluster of its *rarest* scene tag, so an ubiquitous tag
  ("group photo", "family") can't swallow the distinctive ones. Unscored photos trail.

Topic and location are non-sequential — any two clusters may be the closest pair — so they
use affinity-based consolidation (merge undersized groups into their closest sibling, then
merge closest pairs down to the same size-proportional cap) and are then ordered by their
earliest photo, so even a by-topic book moves broadly forwards in time. The AI pass gets
both the matching clusters and an explicit instruction (`groupingInstruction`), restated in
the review round so a revision can't quietly reorganise the book back into a timeline.

Measured on a real 36-photo book: chronological gives 5 date clusters; topic gives
`pet/home`, `couple/selfie`, `beach/sunset/ocean`, `mountains/skiing`, `friends/concert`,
which the design pass named *Das Paar*, *Skifahren in den Bergen*, *Am Strand*, *Mit
Freunden*, *Zuhause & Alltag*. That same book has GPS on **zero** photos — which is why the
config panel checks coverage and warns before you pick a grouping the photos can't support,
rather than silently producing one meaningless chapter.

### 6a. Design-pass hardening (post-launch)

The first shipped version of the AI pass was **all-or-nothing**, and in production that
meant it effectively never ran: the first real book we inspected sat on
`layout_source: 'auto'` despite the user having clicked "Buch erstellen". A single
duplicated `assetId`, one page with 3 photos under a 4-slot template, or one reference to
a photo excluded while the model was thinking discarded the whole design and silently fell
back to the mechanical date-range layout — which the user then judged the AI by. Three
changes address that:

1. **Parse leniently, repair mechanically** (`lib/photo-book-repair.ts`).
   `coercePhotoBookPlan` reads the model's raw JSON into something schema-valid by
   construction (re-grouping wrong-arity pages instead of rejecting them);
   `repairPhotoBookPlan` then reconciles it with the book's current photos — dropping what
   can't be shown, de-duplicating, re-fitting the pages that lost a photo, placing any
   force-included photo the model skipped. The model's judgment (sections, titles, pacing,
   hero) survives; only mechanical defects are fixed. The same function keeps an
   AI/hand-edited plan alive when the photo set changes, instead of the old behaviour where
   excluding one photo caused the next page load to regenerate the book as `'auto'`.
2. **Deterministic design check** (`lib/photo-book-lint.ts`) — "does this layout *work*
   for these photos", separate from "is it structurally legal". `TEMPLATE_SHAPE_RULES` is
   the single source of truth for which photo shapes each template renders well (a
   justified row gives every photo the same height, so one landscape in a `three-column`
   collapses the row into a thin strip) and is printed into the prompt *and* checked
   against the output, so the two can't drift.
3. **Self-review round** — the draft is rendered and screenshotted
   (`lib/photo-book-proof.ts`, Chromium in the worker), and the model is shown its own
   pages plus the lint findings and asked for a corrected plan. The revision is adopted
   only if it scores better on the same check, so a review round can never make a book
   worse. Measured on a real 36-photo book: 5 date-range sections and 4 squashed
   `three-column` rows (score 20) → 7 content-named sections with captions and no shape
   violations (score 0), in ~3.5 minutes.

Because a pass now takes minutes, the worker publishes its stage to `books.design_stage`
(`lib/photo-book-design-stage.ts`) and the builder shows a live checklist instead of an
indefinite spinner; `isDesignInFlight` stops a worker that died mid-pass from leaving that
spinner up — or the book un-designable — forever.

## 7. Style suites (`lib/photo-book-styles.ts`)

v1's `ThemeTokens` (a CSS-variables map in `lib/book-layout.ts`) grows into a **style
suite**: id, display name, swatch, and tokens covering front *and back* cover
composition, title/caption/divider typography, palette, page background, photo
treatment (mat, frame, corner radius, shadow), and divider design. Suites are
**code-defined and closed** — the entire point is that each one is a finished design;
users pick a suite, never a font.

Launch with 6, room for up to 10:

| id | feel |
|---|---|
| `classic` | serif, warm white, thin mats — the existing theme, extended |
| `modern` | clean sans, generous whitespace — existing theme, extended |
| `gallery` | pure white, no frames, small captions — photos do everything |
| `heirloom` | cream paper, elegant serif, ornamental dividers |
| `bold` | dark pages, full-bleed-heavy, large display type |
| `journal` | travel-diary: casual type, date stamps, taped-photo mats |

Fonts are **self-hosted** (added to `public/fonts` + the worker's Docker image) — the
Chromium print render has no network fonts, and the live preview must match the PDF
glyph-for-glyph. Story books keep their two themes for now; folding them into the suite
system is a later cleanup.

## 8. Preview, render, PDF output

**Live preview: keep the HTML/Paged.js approach** (reconsidered, confirmed). It's the
right call for photo books even more than for story books: instant feedback after every
chat edit, no Chromium in the web process, and `loadOrBuildPlan`-style shared plan
resolution guarantees preview and print PDF never disagree on content. New
`lib/photo-book-layout.ts` renders the photo plan (screen + print variants) reusing the
Paged.js plumbing (`lib/pagedjs.ts`, `preview-html` route branches on `kind`).

**Thumbnails as placeholders** (reconsidered): still right — presigned thumbnail URLs
keep the preview light (100+ photos!) — **but 640 px is too soft** for what photo books
show. A story book renders thumbnails into text-column figures; a photo book renders
full-bleed pages where 640 px looks visibly mushy on a laptop. Plan: the `thumbnail` job
gains a second **display rendition** (`assets.display_s3_key`, WebP, ~1600 px longest
edge — the size HEIC thumbs already use) generated for book-owned photos; the preview
uses display renditions for `full-bleed`/`full-framed`/`divider` slots and 640 px thumbs
for multi-photo grids. Print PDF always embeds originals, as today.

**Print PDF**: the existing `render-book` worker job branches on `kind` and renders the
photo layout through the same Chromium pipeline (originals, bleed, page-count padding).
New for photo books: a **"Download PDF"** button on the builder/order page (presigned GET
of the print PDF, triggering a render when stale) — per the product decision, the PDF *is*
the v1 deliverable. The Gelato quote/order screen is reused unchanged.

Worker sizing note: a 100-photo full-resolution render is heavier than any story book —
keep `teamSize: 1`, and downscale embedded originals to the size the page actually
prints at 300 dpi (a 4:1 collage slot doesn't need a 48 MP original inlined).

## 9. Chat refinement — text *and voice*

The book-scoped chat (`book-chat.tsx` → `runBookAgent`, book tools only) is the primary
edit surface. Additions:

**Photo-book tools** (`lib/ai/tools/books.ts`, wrapping new functions in `lib/books.ts` —
the "all mutations in lib/books.ts, tools and UI are thin wrappers" rule holds):

| tool | does |
|---|---|
| `get_photo_book` | sections/pages/photos incl. analysis summaries — the agent *knows* which photo is the blurry one |
| `update_photo_book_layout` | targeted ops: `set_style`, `set_cover`, `set_page_template`, `move_photo`, `swap_photos`, `exclude_photo` / `include_photo`, `rename_section`, `move_section`, `merge_sections`, `set_caption`, `set_title` |
| `redesign_photo_book` | re-queue the AI design pass (optionally scoped to one section) |

Ops set `layout_source: 'edited'`; the existing stale/consistency machinery covers
content changes (photo added/removed → `layout_stale`).

**Voice messages**: reuse the exact story-chat pattern — `AudioRecorder`
(`components/audio-recorder.tsx`, prefer-AAC) drops into `book-chat.tsx`; audio uploads
via the existing audio presign path; the server transcribes with Groq Whisper
(`lib/ai/groq.ts`) and feeds the transcript to `runBookAgent` as the user message
(stored with the audio attachment, like `app/(app)/chat` does). No new infrastructure —
this is assembling three existing pieces.

## 10. Research: importing from Google Photos / Apple Photos (phase 3, optional)

**Google Photos — feasible, moderate effort.** Since March 31, 2025 the Library API
scopes for reading a user's whole library are gone (403 for third-party apps); the
supported path is the **Picker API**: the app opens a Google-hosted picker, the user
multi-selects from their own library (search, albums, all of it), the app polls the
picker session and then downloads the selected originals server-side (short-lived
`baseUrl`s) → straight into our S3 ingest from §3. This fits our flow perfectly — we
*want* explicit selection, not library scraping. Costs: a Google Cloud OAuth client +
**app verification** for the sensitive `photospicker.mediaitems.readonly` scope (the
long pole — days of review, privacy-policy requirements), session-polling plumbing, and
a server-side fetch pipeline. Verdict: **worth doing as phase 3**; design the §3 ingest
so "source: Google Photos" is just another way to feed it.

**Albums**: there is no programmatic "import album X" — the app can never list a user's
albums (Library API album reads are app-created-content-only since the 2025 change), and
share-link albums have no official API. But the *user* can do it inside the picker: the
picker opens on recent photos (albums aren't a browse category) and supports **search by
album title**; the user searches their album and multi-selects its photos. So the
"create an album, import the whole thing" workflow exists, phrased as UI guidance before
opening the picker ("Erstelle in Google Photos ein Album, such es dann im Auswahlfenster
und wähle die Fotos aus") — Google's own docs recommend exactly this instruction
pattern. It's a quick multi-select gesture, not a one-click album import.
Sources: [Google Photos updates](https://developers.google.com/photos/support/updates),
[Picker API launch post](https://developers.googleblog.com/en/google-photos-picker-api-launch-and-library-api-updates/),
[Picker API guide](https://developers.google.com/photos/picker/guides/get-started-picker).

**Apple Photos — no viable API; solved by the platform instead.** There is **no public
iCloud Photos API** for web apps ([Apple Developer Forums](https://developer.apple.com/forums/thread/739454),
[thread](https://developer.apple.com/forums/thread/74434)); the only programmatic routes
are reverse-engineered private APIs ([pyicloud](https://pypi.org/project/pyicloud/)-style)
— fragile, ToS-hostile, credential-handling nightmares. **Don't build on them.** The
good news: on iOS, our PWA's file input *already is* the Apple Photos picker — it
surfaces the full iCloud library and auto-downloads originals on selection. Apple users
are served by making the §3 bulk uploader excellent on mobile Safari (which we need
anyway). Verdict: **no integration**; revisit only if Apple ever ships a web API.

## 11. Delivery plan (PRs)

1. **Schema + ingestion** — `book_kind`, asset ownership change, `book_photos`,
   `photo-meta` job (EXIF + phash), batch presign, bulk uploader UI, create-flow fork
   (kind picker), photo grid in the builder. Ends: a photo book holding 150 analyzed-for-
   metadata photos.
2. **Plan schema + auto-layouter + preview** — `lib/photo-book-plan.ts`, autolayout
   (time/GPS sectioning, dedup, pacing), `lib/photo-book-layout.ts` screen variant,
   display renditions, style suites `classic` + `modern` + `gallery`. Ends: instant
   auto-generated book in the live preview.
3. **Vision analysis + AI design pass** — `photo-vision` batches, `design-photo-book`
   job, culling by scores, AI section titles/captions/cover. Ends: "Design my book"
   visibly beats the deterministic layout.
4. **Chat + voice + targeted ops** — photo-book tools, `updatePhotoBookLayout` ops,
   voice messages in book chat. Ends: "das dritte Foto größer" works, spoken.
5. **Print PDF + download + remaining styles** — `render-book` photo branch, Download
   PDF button, order-screen hookup, styles 4–6, i18n polish (every string en+de,
   du-form). Ends: full journey, PDF in hand.
6. *(Phase 3, separate)* — Google Photos Picker import.

Each PR is independently deployable; 1 touches the orphan sweeper and 5 touches worker
memory/Docker fonts — check `INFRASTRUCTURE.md` before deploying those.

## 12. Open decisions

1. **Photo cap per book** — hard limit (300?) to bound analysis cost and render memory,
   or soft warning only? Plan assumes a hard cap of 300 for v1.
2. **Vision model** — decided (§4): separate `VISION_MODEL` env at flash-lite tier for
   scoring batches; `STYLING_MODEL` keeps the design pass. Remaining question: which
   flash-lite model routes best through OpenRouter for structured JSON on images.
3. **Reverse geocoding** — ship v1 with unnamed GPS clusters (AI names sections from
   content) or bundle an offline coarse-city dataset for "München, Juni 2025" labels?
4. **Display rendition rollout** — generate the 1600 px rendition only for book-owned
   photos (plan) or backfill for story photos too (nicer lightboxes, more storage)?
5. **Upload size limit** — keep 15 MB (plan; covers ~48 MP HEIC/JPEG) or raise for
   photo books?
6. **Existing chronicle photos** — v1 photo books are upload-only; letting users pull
   already-uploaded story photos into a photo book is an obvious fast-follow. Include
   in PR 1 or defer?
