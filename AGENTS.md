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
- All env vars are validated in `lib/env.ts` (zod). Import `{ env }` from there, not
  `process.env`. Use `SKIP_ENV_VALIDATION=1` only for `next build`.
- Two runtime processes from one repo: `web` (`npm start`) and `worker` (`npm run worker`).
- Story lifecycle: `draft → processing → ready | failed`. Voice flow:
  upload audio to S3 → create story (`processing`) → `transcribe` job → `style` job → `ready`.
- Keep raw inputs forever (audio/photos in `assets`) for traceability.

## Commands
- `npm run dev` — web dev server
- `npm run worker:dev` — worker with watch
- `npm run db:push` / `db:generate` / `db:migrate` / `db:studio` — Drizzle
- `docker compose up -d` — local Postgres + MinIO (S3) for development
- `npm run lint`, `npm run build`

## Plan
Full project plan: `~/.claude/plans/curious-gliding-dijkstra.md`. Build phases tracked as tasks.
