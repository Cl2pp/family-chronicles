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
- **Books**: stories can be typeset into a printable hardcover (`books`, `book_stories`,
  `book_orders`). ALL book mutations live in `lib/books.ts`; the UI (`app/(app)/books`) and
  the chat agent (`lib/ai/tools/books.ts`) are thin wrappers over it. The worker's
  `render-book` job (`lib/book-render.ts` + `lib/book-layout.ts`) prints HTML to preview +
  print PDFs via Chromium. Pricing = Gelato quote (`lib/gelato.ts`); v1 ordering stops at an
  admin email (`lib/email.ts`) — no payment, no Gelato order submission. Full plan:
  `docs/BOOK_FEATURE_PLAN.md`.

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
