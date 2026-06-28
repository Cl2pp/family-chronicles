# Deployment — Hetzner + Coolify

Family Chronicle deploys as **two apps from one repo** (web + worker) onto a single Hetzner
VPS running **Coolify**. After the one-time setup, the day-to-day loop is just `git push`.

## The day-to-day loop (after setup)

1. Commit & push to `main`.
2. Coolify's GitHub webhook fires → it rebuilds both apps from the `Dockerfile`.
3. The **web** app's pre-deploy command runs `npm run db:migrate` (applies new migrations).
4. New containers go live behind Traefik (domain + automatic TLS).

That's it — every change ships the same way.

---

## One-time setup

### 1. Provision the server (`hcloud`, from this machine)

```bash
hcloud server create \
  --name family-chronicle \
  --type cax21 \
  --image ubuntu-24.04 \
  --location fsn1 \
  --ssh-key family-chronicle-deploy
```

Get the IP: `hcloud server ip family-chronicle`. SSH in with the deploy key:

```bash
ssh -i ~/.ssh/family_chronicle_ed25519 root@<SERVER_IP>
```

### 2. Install Coolify

On the server:

```bash
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash
```

Then open `http://<SERVER_IP>:8000`, create the admin account, and add this server as the
deployment target (Coolify usually registers "localhost" automatically).

### 3. Database + object storage (inside Coolify)

- **PostgreSQL** — add a Postgres resource (Coolify one-click). Copy its connection string for
  `DATABASE_URL`.
- **Object storage** — either:
  - add **MinIO** as a Coolify service (S3-compatible, runs on the box), create a bucket
    `family-chronicle`, and set `MINIO_API_CORS_ALLOW_ORIGIN` to the app domain; **or**
  - use **Hetzner Object Storage** (managed) and create a bucket there.
  - Either way, set a CORS rule allowing `PUT, GET` from the app's domain (browser uploads use
    presigned URLs).

### 4. Create the two apps (inside Coolify)

Connect the GitHub repo (`Cl2pp/family-chronicles`, branch `main`), then create **two
applications** from it, both using **Build Pack: Dockerfile**:

| App | Port | Start command | Pre-deploy command |
|---|---|---|---|
| **web** | `3000` | _(default — `npm run start`)_ | `npm run db:migrate` |
| **worker** | — (no domain) | override to `npm run worker` | — |

Assign your domain to **web**; Coolify provisions Let's Encrypt TLS via Traefik. Set the web
app's health check path to `/api/health`.

### 5. Environment variables (set on BOTH apps)

```
NODE_ENV=production
DATABASE_URL=postgres://...                 # from the Coolify Postgres resource
BETTER_AUTH_SECRET=<openssl rand -base64 32>
BETTER_AUTH_URL=https://<your-domain>
OPENROUTER_API_KEY=...
STYLING_MODEL=anthropic/claude-opus-4-8
GROQ_API_KEY=...
S3_ENDPOINT=...                             # MinIO/Hetzner/R2 endpoint
S3_REGION=auto
S3_BUCKET=family-chronicle
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_FORCE_PATH_STYLE=true                     # true for MinIO; false for AWS S3
```

### 6. Enable auto-deploy

Turn on "auto deploy on push" for both apps (Coolify installs the GitHub webhook). Push to
`main` now deploys automatically.

---

## Debugging on the box

- `ssh -i ~/.ssh/family_chronicle_ed25519 root@<SERVER_IP>` then `docker ps`, `docker logs <id>`.
- Or use Coolify's per-app **Logs** and **Terminal**.
- Connecting Coolify's MCP server lets Claude Code drive deploys/inspect logs directly.

## Notes

- The image is shared by both apps; only the start command differs (`npm run start` vs
  `npm run worker`). Keep them on the same env vars.
- First deploy: run `npm run db:migrate` once (the web pre-deploy command does this on every
  deploy; it's a no-op when there's nothing new).
- `cax21` is ARM — the stack is all JS, so it builds and runs natively on ARM.
