# Family Chronicle

A private, multi-user **Progressive Web App** where families collect their stories — typed or
spoken — and have them transcribed and gently rewritten into a shared, third-person
family-memoir, placed on a timeline. Built to be self-hosted on a server you can SSH into.

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router) — web + installable PWA |
| UI | Mantine v9 (light-mode only) |
| Database | PostgreSQL + Drizzle ORM |
| Auth | better-auth (email/password + magic link) |
| Storage | S3-compatible (Hetzner Object Storage / Cloudflare R2 / MinIO locally) |
| Transcription | Groq Whisper (`whisper-large-v3-turbo`) |
| Story styling | OpenRouter (model configurable via `STYLING_MODEL`) |
| Jobs | pg-boss (Postgres-backed) + a separate worker process |
| Hosting | Hetzner VPS + Coolify |

## Local development

1. **Start infrastructure** (Postgres + MinIO):
   ```bash
   docker compose up -d
   ```
2. **Configure env**:
   ```bash
   cp .env.example .env
   # then set OPENROUTER_API_KEY, GROQ_API_KEY, and a BETTER_AUTH_SECRET
   # (openssl rand -base64 32). The Postgres/MinIO defaults already match compose.
   ```
3. **Create the database schema**:
   ```bash
   npm run db:push
   ```
4. **Run the app + worker** (two terminals):
   ```bash
   npm run dev          # web on http://localhost:3000
   npm run worker:dev   # transcription + styling worker
   ```

MinIO console: http://localhost:9001 (minioadmin / minioadmin).

## Useful scripts

- `npm run db:generate` — generate SQL migrations from the schema
- `npm run db:migrate` — apply migrations (use in production)
- `npm run db:push` — push schema directly (handy in dev)
- `npm run db:studio` — Drizzle Studio
- `npm run lint`, `npm run build`

## Deployment (Coolify on a Hetzner VPS)

Deploy **two apps from this one repo/image**:

- **web** — default command (`npm run start`), exposed on the domain.
- **worker** — command overridden to `npm run worker`.

Both share the same environment variables (`DATABASE_URL`, `OPENROUTER_API_KEY`,
`STYLING_MODEL`, `GROQ_API_KEY`, S3 credentials, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`).
Run `npm run db:migrate` once on deploy to apply migrations. Coolify's reverse proxy handles
the domain + TLS.

**Object storage CORS.** Voice/photo uploads go straight from the browser to S3 via presigned
URLs, so the bucket must allow cross-origin `PUT` (and `GET`) from your app's domain. Configure
a CORS rule on the bucket allowing `PUT, GET` for your origin (locally, MinIO is set to allow
all origins via `MINIO_API_CORS_ALLOW_ORIGIN` in `docker-compose.yml`).
