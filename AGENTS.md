<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Family Chronicle

A private, multi-user **PWA** where families collect stories (typed or voice) and have them
transcribed and rewritten into a shared third-person family-memoir, placed on a timeline.

## Stack
- **Next.js 16** (App Router) + **Mantine v9** (UI; light-mode only — see `app/theme.ts`)
- **PostgreSQL** + **Drizzle ORM** (`db/schema.ts`, `db/index.ts`)
- **better-auth** (`lib/auth.ts`, client `lib/auth-client.ts`, route `app/api/auth/[...all]`)
- **pg-boss** job queue (`lib/queue.ts`) + **worker** process (`worker/index.ts`)
- **S3-compatible** storage (`lib/s3.ts`) for audio + photos
- AI: **OpenRouter** for styling (`lib/ai/openrouter.ts`, model = `STYLING_MODEL` env),
  **Groq Whisper** for transcription (`lib/ai/groq.ts`). Anthropic has no audio API — never
  route transcription through it.

## Key conventions
- The top-level space is a **chronicle** (`chronicles` table; user access via `memberships`,
  tree membership via `chronicle_members`). **Families are never stored or set up** — they are
  tags derived on the fly from `people.family_name` + kinship edges (own surname, all ancestor
  surnames, spouse surnames); see `lib/family-tags.ts`. A story's tags = union over its people.
- All env vars are validated in `lib/env.ts` (zod). Import `{ env }` from there, not
  `process.env`. Use `SKIP_ENV_VALIDATION=1` only for `next build`.
- Two runtime processes from one repo: `web` (`npm start`) and `worker` (`npm run worker`).
- Story lifecycle: `draft → processing → ready | failed`. Voice flow:
  upload audio to S3 → create story (`processing`) → `transcribe` job → `style` job → `ready`.
- Keep raw inputs forever (audio/photos in `assets`) for traceability.
- Source material is tracked per **contribution** (`contributions` table; who/when/verbatim
  text, assets link via `assets.contribution_id`) — the story page renders these as a
  timeline. Every flow that adds source (accept, chat revision, photo add) writes one.
- Voice notes recorded as WebM/Opus are re-encoded to AAC (`.m4a`) by the worker's
  `transcode` job — Safari/iOS can't play Opus. Prefer-AAC recording lives in
  `components/audio-recorder.tsx`.
- Photos get a downscaled WebP (`assets.thumb_s3_key`, worker's `thumbnail` job via
  sharp, `lib/thumbnails.ts`). Banners and grids load the thumbnail; only the
  lightbox fetches the full-size original.
- **Books**: stories can be typeset into a printable hardcover (`books`, `book_stories`,
  `book_orders`). ALL book mutations live in `lib/books.ts`; the UI (`app/(app)/books`) and
  the chat agent (`lib/ai/tools/books.ts`) are thin wrappers over it. Layout is data, not
  code: a per-book JSON `layout_plan` (schema + validation in `lib/book-layout-plan.ts`,
  deterministic heuristic producer in `lib/book-autolayout.ts`) says what goes where.
  Content loading + plan resolution (`loadBook`, `loadOrBuildPlan`) live in
  `lib/book-content.ts`, shared by both processes. The **builder's own preview is live
  HTML**: `app/api/books/[bookId]/preview-html` renders the current plan in the web
  process (presigned thumbnail URLs, no Chromium, `Cache-Control: no-store`) via
  `lib/book-layout.ts`'s `screen` variant, which injects a self-hosted **Paged.js**
  polyfill (`app/api/pagedjs-polyfill`, see `lib/pagedjs.ts`) to paginate it client-side —
  edits show up instantly, no render wait. The worker's `render-book` job
  (`lib/book-render.ts`, rebuilding the plan when missing or `layout_stale`) still
  renders the `preview`/`print` PDF variants through Chromium, but that's now the
  **order-time print proof**: the order page (`app/(app)/books/[bookId]/order`) triggers
  and polls for it when a book isn't `preview_ready` yet, since ordering needs the exact
  page count and a full-resolution binding PDF. Pricing = Gelato quote (`lib/gelato.ts`);
  v1 ordering stops at an admin email (`lib/email.ts`) — no payment, no Gelato order
  submission. Full plan: `docs/BOOK_FEATURE_PLAN.md` (layout v2 plan:
  `docs/book-layout-plan` branch, `docs/BOOK_LAYOUT_PLAN.md`). A "Design my book" button
  queues the `design-book` job (`lib/book-ai-layout.ts`'s `proposeLayoutPlan`, worker-side):
  a vision-capable model looks at the book's chapters and actual photos and proposes a new
  `layout_plan` (`layout_source: 'ai'`), falling back to the auto-layouter silently on any
  failure — `books.design_requested_at` tracks the in-flight state for the builder's poll.

## Commands
- `npm run dev` — web dev server
- `npm run worker:dev` — worker with watch
- `npm run db:push` / `db:generate` / `db:migrate` / `db:studio` — Drizzle
- `docker compose up -d` — local Postgres + MinIO (S3) for development
- `npm run lint`, `npm run build`

## Deployment & infrastructure
The app is **live in production** at https://family.clepp.de (Hetzner VPS + Coolify + Cloudflare
R2). Before touching anything deploy/server/storage-related, read **`INFRASTRUCTURE.md`** — it
documents the server, Coolify, R2 (incl. the EU-endpoint gotcha), the security model (admin ports
are private; reach Coolify via SSH tunnel), env vars, the deploy loop, and the gotchas we hit.
`DEPLOY.md` is the from-scratch runbook.

## Plan
Full project plan: `~/.claude/plans/curious-gliding-dijkstra.md`. Build phases tracked as tasks.
