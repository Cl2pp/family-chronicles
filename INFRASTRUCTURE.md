# Familienwerk — Infrastructure & Operations

This document explains how Familienwerk is built, deployed, and operated in production —
written so a future agent or engineer can pick it up cold. For the **code** conventions see
`AGENTS.md`; for the **step-by-step deploy runbook** see `DEPLOY.md`; for the original product
plan see `~/.claude/plans/curious-gliding-dijkstra.md`.

**Live:** https://familienwerk.co (real Let's Encrypt HTTPS)
**Repo:** https://github.com/Cl2pp/family-chronicles (private, branch `main`)

---

## 1. What it is

A private, multi-user PWA where families collect stories (typed or spoken). Voice is transcribed
and every story is rewritten into a consistent third-person "family memoir" voice via an LLM,
following a per-family style guide. Stories carry photos, sit on a timeline (with fuzzy dates),
and keep full traceability (who submitted what + the raw inputs).

## 2. Architecture

```
                     Internet (family members)
                              │  HTTPS
                              ▼
   Hetzner VPS (cx23, Nuremberg)  ── Coolify (Docker) ──┐
     ├─ Traefik (coolify-proxy)  :80/:443  TLS + routing │
     ├─ web     app  (Next.js)   :3000  ← UI + server actions + API   (ROLE unset)
     ├─ worker  app  (same image):       ← transcribe + style jobs    (ROLE=worker)
     └─ Postgres (Coolify resource)      ← application database
                              │                    ▲
        ┌─────────────────────┼────────────────────┘
        ▼                     ▼
  Cloudflare R2 (EU)    OpenRouter (LLM)   Groq (Whisper)
  audio + photos        story styling      voice transcription
```

- **One Docker image, two apps.** `web` and `worker` are built from the **same `Dockerfile`**.
  The container's `docker-entrypoint.sh` chooses behavior from the `ROLE` env var: unset → web
  (`npm run start`), `ROLE=worker` → the pg-boss job worker (`npm run worker`). The **web role
  also runs `npm run db:migrate` on startup** (Coolify's pre-deploy proved unreliable).
- **Background jobs** use **pg-boss** (queues live in the same Postgres). Flow: voice story →
  upload audio to R2 → `transcribe` job (Groq Whisper) → `style` job (OpenRouter) → `ready`.
  Text story → `style` job → `ready`. Status lifecycle: `draft → processing → ready | failed`.
- **Stateless apps, stateful data.** All durable state is in **Postgres** (text/metadata) and
  **R2** (audio/photos). `web`/`worker` containers are disposable.

## 3. Server (Hetzner)

| | |
|---|---|
| Provider/project | Hetzner Cloud, project `15154790` |
| Server | name `family-chronicle`, id `145962441`, type **cx23** (x86, 2 vCPU / 4 GB / 40 GB) |
| Why cx23 (not ARM cax) | ARM (cax) was sold out in all EU regions at provision time; the image is multi-arch so x86 was a drop-in, and it's ~€0.50/mo cheaper |
| Location | `nbg1` (Nuremberg, DE) |
| OS | Ubuntu 24.04 |
| Swap | 4 GB swapfile (added via cloud-init) so the 4 GB box can build Next.js |
| Public IPv4 | `157.90.165.169` |
| Cost | ~€5.49/mo |
| SSH | `ssh -i ~/.ssh/family_chronicle_ed25519 root@157.90.165.169` (key-only; passwords disabled) |

The SSH **private key lives on the operator's Mac** at `~/.ssh/family_chronicle_ed25519`
(passphrase-less, dedicated to this server). Its public key is registered as Hetzner SSH key
`family-chronicle-deploy` and injected into the server.

`hcloud` CLI is configured locally (context `family-chronicle`) — use it to manage the server
(`hcloud server …`, `hcloud firewall …`). It works from anywhere (token auth), so it's the
recovery path if SSH ever gets locked out.

## 4. Coolify (the PaaS layer)

- **Coolify 4.1.2** runs on the server (installed via the official one-line installer). It manages
  the Docker containers (apps, Postgres, Traefik).
- Onboarding chose **"This Machine"** (single-server: deploy onto the box Coolify runs on).
- **Two applications**, both **Private Repository (deploy key)** → repo
  `git@github.com:Cl2pp/family-chronicles.git`, branch `main`, **Build Pack: Dockerfile**,
  Base Directory `/`:
  - **web** — port `3000`, domain `https://familienwerk.co`, health check `/api/health`.
  - **worker** — no domain, no exposed port, no health check, env `ROLE=worker`.
- **PostgreSQL** is a Coolify database resource in the same project (so it shares the Docker
  network; the apps reach it by its internal hostname).

**Accessing the Coolify dashboard (important — it is NOT public):** the admin UI is firewalled
off the internet. Reach it via an SSH tunnel:
```bash
ssh -i ~/.ssh/family_chronicle_ed25519 -N \
  -L 8000:localhost:8000 -L 6001:localhost:6001 -L 6002:localhost:6002 \
  root@157.90.165.169
# then open http://localhost:8000  (localhost is a secure context; traffic rides inside SSH)
```
New-user registration is **disabled** in Coolify settings.

## 5. Security model

- **Hetzner Cloud Firewall** (`family-chronicle-fw`, attached to the server). Inbound allowed:
  `22` (SSH), `80`, `443` (the app), `icmp` — **from anywhere**. The admin/realtime ports
  (`8000` Coolify, `8080` Traefik, `6001`/`6002` realtime) are **closed to the internet** and
  reached only via the SSH tunnel above. (We deliberately moved off IP-allowlisting to
  "not exposed at all + reach via SSH".)
- **SSH** is key-only (`PasswordAuthentication no`, root `prohibit-password`) via a drop-in at
  `/etc/ssh/sshd_config.d/00-hardening.conf`.
- **App-level**: better-auth (email/password + magic link). Every chronicle/story server action
  checks membership/role (`requireMembership` / `requireEditor`). Client-supplied S3 object keys
  are constrained to the chronicle's own prefix (`assertOwnedKey`) to prevent cross-chronicle
  media references. React escapes story content (no `dangerouslySetInnerHTML`).
- **Secrets** live only in Coolify env (per app) and the server; never in the repo (`.env` is
  gitignored). The R2 token is **object-scoped** (Object Read & Write) — it cannot do bucket-admin
  ops (e.g. setting CORS), which is why CORS is set in the Cloudflare dashboard.

## 6. Object storage — Cloudflare R2

- Bucket **`family-chronicle`**, **EU jurisdiction**. Free tier; free egress.
- **⚠️ EU-jurisdiction gotcha:** the bucket must be addressed via the **EU endpoint** —
  `https://<account-id>.eu.r2.cloudflarestorage.com` (note the `.eu.`). Using the default
  (non-EU) endpoint returns `AccessDenied` for *all* operations even with valid credentials.
  `S3_ENDPOINT` is set to the `.eu.` form.
- `S3_FORCE_PATH_STYLE=true` (R2's default endpoint addresses buckets by path).
- **Uploads are direct browser → R2** via presigned PUT URLs (server authorizes the editor and
  signs the URL; the browser PUTs the file). So R2 needs a **CORS policy** allowing the app
  origin. Current policy (set in Cloudflare → R2 → bucket → Settings → CORS Policy):
  ```json
  [{ "AllowedOrigins": ["https://familienwerk.co"],
     "AllowedMethods": ["GET","PUT"], "AllowedHeaders": ["*"],
     "ExposeHeaders": ["ETag"], "MaxAgeSeconds": 3600 }]
  ```
  When the app domain changes, update this origin too.

## 7. Domain, DNS, TLS

- Domain **`familienwerk.co`** — a separate apex domain (its own `.co` registration; **not**
  a subdomain of `clepp.de`). DNS: an **A record** `@ (familienwerk.co) → 157.90.165.169`
  (add a `www` CNAME → `familienwerk.co` if you want the www host too). Set this at whichever
  registrar/DNS provider holds `familienwerk.co`, then add the domain to the Coolify **web** app
  so Traefik issues the Let's Encrypt cert.
- **TLS** is a real Let's Encrypt cert, auto-provisioned and renewed by Coolify/Traefik (HTTP-01
  over port 80). HTTP redirects to HTTPS.
- **Cloudflare proxy (orange cloud): leave it OFF (DNS-only).** Traefik gets its cert via
  Let's Encrypt HTTP-01 on port 80, and an enabled proxy terminates TLS at Cloudflare's edge and
  can intercept the ACME challenge, breaking issuance. If you later want Cloudflare's WAF/CDN,
  enable the proxy **only after** HTTPS is confirmed working, and set **SSL/TLS mode to
  "Full (strict)"** (never "Flexible" — it makes Cloudflare talk HTTP to the origin while the app
  forces HTTPS, causing a redirect loop). Don't cache authenticated HTML, the service worker, or
  the manifest. (R2 storage + its CORS origin are independent of the app-domain proxy setting.)
- **Do not use `*.sslip.io` for HTTPS** — Let's Encrypt rate-limits that shared suffix, so cert
  issuance fails. (sslip.io works over plain HTTP only; we used a real domain instead.)

## 8. Environment variables

Set on **both** apps in Coolify (worker additionally has `ROLE=worker`). Validated at boot by
`lib/env.ts` (zod) — a missing/invalid value crashes the container with a clear message; build
time skips validation via `SKIP_ENV_VALIDATION=1` in the Dockerfile.

| Var | Purpose | Source / notes |
|---|---|---|
| `DATABASE_URL` | Postgres connection | Coolify Postgres resource → internal URL |
| `BETTER_AUTH_SECRET` | auth signing secret | `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | app's public origin | must equal the live domain: `https://familienwerk.co` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google sign-in (optional) | Google Cloud → OAuth 2.0 Web client. Redirect URI = `<BETTER_AUTH_URL>/api/auth/callback/google` → in prod `https://familienwerk.co/api/auth/callback/google` (and `http://localhost:3000/api/auth/callback/google` for dev). Both must be set to enable the provider server-side |
| `NEXT_PUBLIC_GOOGLE_AUTH_ENABLED` | show the Google button | `true` to render "Continue with Google" on login/signup. Set together with the two `GOOGLE_*` secrets (it's build-time inlined, so a redeploy is needed to toggle) |
| `OPENROUTER_API_KEY` | story styling | OpenRouter |
| `STYLING_MODEL` | which LLM to style with | e.g. `anthropic/claude-opus-4-8` (swap for cost) |
| `GROQ_API_KEY` | voice transcription | Groq (optional — voice only) |
| `S3_ENDPOINT` | R2 endpoint | **EU** form: `https://<acct>.eu.r2.cloudflarestorage.com` |
| `S3_REGION` | `auto` | R2 |
| `S3_BUCKET` | `family-chronicle` | exact name |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | R2 S3 token | R2 → Manage API Tokens (Object R&W). Key = 32 hex, secret = 64 hex |
| `S3_FORCE_PATH_STYLE` | `true` | for R2 |
| `ROLE` | `worker` on the worker app only | selects the process in `docker-entrypoint.sh` |

## 9. The deploy loop (every change)

1. `git push` to `main`.
2. **A push auto-deploys both apps** via Coolify's **GitHub App** integration (account-level, not
   a repo webhook — there is nothing in the repo's GitHub → Settings → Webhooks). Web and worker
   both have auto-deploy on and build from the same `Dockerfile`.
3. **Builds are serialised.** The server's **`concurrent_builds` is `1`** (`server_settings`), so
   even though a push enqueues both, Coolify runs **one build at a time** — web first (it's queued
   first), then worker. They never build concurrently.
4. The web container **runs migrations on startup** (`docker-entrypoint.sh` — there is **no**
   Coolify pre/post-deploy command; the pre-deploy hook proved unreliable), then serves; Traefik
   swaps it in. The worker builds next and restarts.

Builds take ~2–4 min each on this box (swap covers the Next build's memory spike), so a push is
~4–8 min end to end.

> **⚠️ `concurrent_builds=1` is load-bearing (see §11).** Coolify's default is **2**, and with two
> simultaneous Next.js builds on this 2-core / 4 GB box the RAM and disk-write spikes double and
> the builds tend to fail *together* — that was the main deploy-failure cause. Serialising them is
> the fix. Set it in Coolify → Server → Advanced, or
> `update server_settings set concurrent_builds = 1 where id = 1;`. (Note: the per-app
> "auto deploy on push" toggle / `is_auto_deploy_enabled` does **not** gate GitHub-App pushes in
> this Coolify version — a push deploys every connected app regardless, which is why the
> server-wide build limit, not a per-app flag, is what serialises them.)

**Version skew after deploys**: each Docker build writes `.deployment-id` (from Coolify's
`SOURCE_COMMIT` build arg, or a build timestamp) and `next.config.ts` uses it as Next's
`deploymentId`. Without it, PWA clients that kept an old page open across a redeploy hit
"Failed to find Server Action" (the old bundle's action IDs no longer exist on the new server) and
silently stay broken until a manual reload. With it, Next hard-reloads on navigation skew, and
`components/deployment-guard.tsx` reloads stale clients when a dead action is called or when the
resumed app's id no longer matches `/api/version`. Occasional "Failed to find Server Action"
warnings in the web logs right after a deploy are expected — that's an old client being told to
reload itself.

## 10. Operating & debugging (over SSH)

Containers are named by Coolify; **find them dynamically** (the `-<id>` suffix changes each deploy):
```bash
WEB=$(docker ps --format '{{.Names}}' | grep -E '^lfezes7na9u52r8ka10dh57e' | head -1)   # web app
WK=$(docker ps  --format '{{.Names}}' | grep -E '^jopm4dv6n3x5uhygcixtalhl' | head -1)   # worker app
PG=$(docker ps  --format '{{.Names}}' | grep -E '^bznln3o' | head -1)    # app Postgres
```
(Those prefixes are the apps' stable Coolify names as of July 2026; re-derive from `docker ps` if
the resources are ever recreated — check `docker logs` to tell which is which: web prints
"✓ Ready in", worker prints "[worker] ready".)

```bash
docker ps                              # what's running
docker logs --tail 50 "$WEB"           # web logs (look for "✓ Ready in")
docker logs --tail 50 "$WK"            # worker logs (look for "[worker] ready")
docker inspect "$WEB" -f '{{range .Config.Env}}{{println .}}{{end}}'   # container env
docker exec "$WEB" npm run db:migrate  # apply migrations manually
docker exec "$PG" sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -c "\dt"'   # list tables
```
To run an R2/S3 maintenance script with the app's creds, drop a `.cjs` file into `/app` inside the
web container (so it resolves `node_modules`) and `node` it — that's how CORS/upload checks were
done (the creds never leave the box).

## 11. Gotchas we hit (so you don't re-hit them)

- **Mantine compound components in Server Components.** Using `<Tabs.Tab>` / `<Accordion.Item>`
  etc. directly in a Server Component crashes ("Element type is invalid … undefined") because a
  `'use client'` module's static subcomponents resolve to `undefined` in RSC. Keep compound/tabbed
  UI inside a `'use client'` component (see `chronicle-view.tsx`).
- **Coolify env must be Saved.** Pasting env in the Developer view does nothing until you click
  Save; then redeploy. Symptom: container crashes on `lib/env.ts` validation.
- **sslip.io can't get a TLS cert** (Let's Encrypt rate limit). Use a real domain.
- **R2 EU jurisdiction needs the `.eu.` endpoint** (see §6). Symptom: `AccessDenied` on everything.
- **R2 object token can't set CORS** — set CORS in the dashboard.
- **Node version on PATH.** A stale `/usr/local/bin/node` (Node 16) can shadow nvm's Node 22 if
  you prepend system paths; that breaks eslint (`structuredClone is not defined`). Use the repo's
  default Node 22 for `npm`/build.
- **ARM (cax) capacity** is often sold out at Hetzner; x86 (cx/cpx) is the fallback (multi-arch image).
- **Deploys failing under load = disk + concurrency (the #1 operational issue).** The 40 GB disk
  fills with Docker image layers, and back-to-back app+worker builds outpace cleanup. Symptoms:
  builds die with `no space left on device`; at 100% full even **coolify-db (Postgres) crashes**
  and the Coolify UI throws a 500 (`SQLSTATE[53100] … No space left on device`). A softer variant
  (hit 2026-07-16): near-full disk makes **coolify-redis** fail its RDB snapshot, Redis goes
  read-only (`MISCONF … stop-writes-on-bgsave-error`), the UI 500s with that message and — worse —
  **Horizon (Coolify's queue) wedges, so Coolify's own scheduled cleanup can no longer run**.
  Debugging notes:
  - Docker uses the **containerd image store**, so reclaimable layers live in **`/var/lib/containerd`**
    (~29 GB when full), **not** `/var/lib/docker` — `du` on the latter is misleading. Check with
    `docker system df` and `du -xh --max-depth=2 /var | sort -rh | head`.
  - Reclaim: `docker builder prune -af && docker image prune -af` (only removes layers not used by
    a **running** container — web/worker/db images are safe). Frees ~17 GB in the full state.
  - **Docker Cleanup** (Coolify → Server → Docker Cleanup) runs on `server_settings.docker_cleanup_frequency`
    at **`30 * * * *`** (moved off `0 * * * *` on 2026-07-16 so it can't prune mid-build), threshold 80%.
  - **Host-level disk guard** (added 2026-07-16, after the Redis-MISCONF variant above): Coolify's
    cleanup can't save a disk that already wedged its own Redis/queue, so
    `/etc/cron.d/docker-disk-guard` runs `/usr/local/bin/docker-disk-guard.sh` every 5 min,
    **independent of Coolify** (plain cron + docker). Levels: <80% no-op; ≥80% prune build cache +
    dangling images, but **defers while a `coolify-helper` build container is running** (a mid-build
    prune can kill the build — it instead fires within 5 min of the build finishing); if still ≥90%
    also prune all unused images (sacrifices rollback tags); ≥95% act even mid-build (at 100% the
    build dies anyway and takes coolify-db/redis with it). Logs to syslog as `docker-disk-guard`
    (`journalctl -t docker-disk-guard`). One deploy burst writes ~16 GB (steady state after deep
    clean is ~56%, peaks hit 98%), so the box lives close to the edge — the durable fix remains the
    cx33 resize (§12).
  - **Concurrent app+worker builds** were the trigger — a push auto-deploys both apps, and with
    Coolify's default `concurrent_builds=2` they built simultaneously, doubling the RAM/disk spike.
    **Fixed** by setting `server_settings.concurrent_builds = 1` (serialises all builds, §9).
- **Phantom `in_progress` deploys block the queue.** If a build dies mid-run (disk-full, DB crash,
  a cleanup prune), its `application_deployment_queues` row can stay `in_progress` forever with a
  frozen `updated_at`, silently blocking every later deploy (Coolify serializes per app). Detect:
  `select id, application_name, status, extract(epoch from (now()-updated_at)) from
  application_deployment_queues where status in ('in_progress','queued');` — anything stale >~12 min
  is dead. Fix: `update application_deployment_queues set status='failed' where id=<id>;` then retrigger.

## 12. Outstanding / future work

- **Magic-link email**: removed for now (the link was only logged to the server console, so the
  login button silently did nothing in production). Re-add the better-auth `magicLink` plugin once
  a real email provider (Resend/SMTP) is wired.
- **Voice transcription** needs a real `GROQ_API_KEY` (still a placeholder unless set).
- **Backups**: enable Coolify scheduled Postgres dumps to R2 (and optionally Hetzner snapshots).
  Media already lives durably in R2.
- **Concurrent-build failures — fixed** (2026-07-16, see §9/§11): builds are serialised via
  `server_settings.concurrent_builds = 1`, so a push's web+worker deploys no longer build at the
  same time. (An earlier attempt to sequence them with a web→worker `post_deployment_command`
  chain was removed once we found the real lever — per-app `is_auto_deploy_enabled` doesn't gate
  GitHub-App pushes, but the server-wide build limit does.)
- **Scale the box**: the 40 GB disk / 4 GB RAM is the underlying ceiling — layers creep back toward
  full and concurrent builds starve each other for RAM. A one-step `hcloud server resize` to **cx33**
  (4 vCPU / 8 GB / 80 GB, ~€10/mo) gives durable headroom and faster builds. Requires a brief reboot.
- **PWA over HTTPS** now works (we're on a real domain) — verify install/offline on devices.

## 13. Pointers

- `DEPLOY.md` — the from-scratch deploy runbook.
- `AGENTS.md` — code conventions + Next.js 16 notes.
- `README.md` — local development.
- `~/.claude/plans/curious-gliding-dijkstra.md` — original product/stack plan.
