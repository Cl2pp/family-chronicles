# Deployment — Hetzner + Coolify

Familienwerk deploys as **two apps from one repo** (web + worker) onto a single Hetzner
VPS running **Coolify**. After the one-time setup, the day-to-day loop is just `git push`.

## The day-to-day loop (after setup)

1. Commit & push to `main`.
2. Coolify's GitHub webhook fires → it rebuilds **both** apps (web + worker) from the `Dockerfile`,
   **concurrently**.
3. The **web** container runs `npm run db:migrate` **on startup** (inside `docker-entrypoint.sh` —
   not a Coolify pre-deploy hook, which proved unreliable), then serves.
4. New containers go live behind Traefik (domain + automatic TLS).

That's it — every change ships the same way.

> ⚠️ Those two **concurrent** builds are the main deploy-failure cause on this small VPS
> (disk/RAM exhaustion — see `INFRASTRUCTURE.md` §9 and §11). To deploy **sequentially** instead
> (web first, worker only after web finishes), run the on-box helper
> `/root/deploy-sequential.sh` rather than relying on the concurrent webhook fan-out.

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

| App | Port | Role env | Migrations |
|---|---|---|---|
| **web** | `3000` | _(none — defaults to web)_ | run on **startup** in `docker-entrypoint.sh` |
| **worker** | — (no domain) | `ROLE=worker` | — |

Both apps use the **same Dockerfile/image**; the container's `docker-entrypoint.sh` runs the
web server by default, or the job worker when `ROLE=worker` is set. The **web** role also runs
`npm run db:migrate` on startup — do **not** rely on a Coolify pre-deploy command (it proved
unreliable; leave the pre/post-deploy fields empty). (Coolify doesn't expose a
start-command field for Dockerfile apps, so the role is selected via env var.)

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

> ⚠️ With auto-deploy on **both** apps, one push builds web **and** worker at the same time. On a
> small box that concurrency is the main cause of failed deploys (see `INFRASTRUCTURE.md` §9/§11).
> Consider disabling the worker's webhook and chaining it off web's `post_deployment_command`, or
> deploy via the sequential helper `/root/deploy-sequential.sh`.

---

## Debugging on the box

- `ssh -i ~/.ssh/family_chronicle_ed25519 root@<SERVER_IP>` then `docker ps`, `docker logs <id>`.
- Or use Coolify's per-app **Logs** and **Terminal**.
- Connecting Coolify's MCP server lets Claude Code drive deploys/inspect logs directly.

## Notes

- The image is shared by both apps; only the start command differs (`npm run start` vs
  `npm run worker`). Keep them on the same env vars.
- First deploy: run `npm run db:migrate` once (the web container also runs this on every startup;
  it's a no-op when there's nothing new).
- `cax21` is ARM — the stack is all JS, so it builds and runs natively on ARM.
