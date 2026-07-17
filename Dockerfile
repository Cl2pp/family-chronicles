# Single image runs BOTH services; the ROLE env var selects which:
#   ROLE unset/anything → web  (npm run start)
#   ROLE=worker         → background job worker (npm run worker)
FROM node:22-alpine AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# ── deps ─────────────────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json ./
# The book renderer uses the system Chromium installed in the runtime stage —
# don't let puppeteer download its own ~170 MB copy into node_modules.
ENV PUPPETEER_SKIP_DOWNLOAD=1
RUN npm ci

# ── build ────────────────────────────────────────────────────────────────────
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Real secrets aren't present at image-build time; skip env validation here.
ENV SKIP_ENV_VALIDATION=1
# Version-skew protection: stamp this deployment. next.config.ts reads the file
# during `next build` here AND during `next start` in the runtime stage (the
# whole /app dir is copied), so client and server always agree. Coolify passes
# SOURCE_COMMIT; the timestamp fallback covers other builders.
ARG SOURCE_COMMIT
RUN echo "${SOURCE_COMMIT:-$(date +%Y%m%d%H%M%S)}" > .deployment-id
# NEXT_PUBLIC_* are inlined into the client bundle at `next build` time, so the
# PostHog key must be present HERE, not just at runtime. Coolify passes it as a
# --build-arg (env var marked "Available at Buildtime"); without this ARG Docker
# drops it and browser-side analytics silently never initializes. (Only the key
# needs baking — the host is hardcoded to /ingest client-side and defaults to
# the EU host server-side, so leaving it unset keeps the env.ts default intact.)
ARG NEXT_PUBLIC_POSTHOG_KEY
ENV NEXT_PUBLIC_POSTHOG_KEY=$NEXT_PUBLIC_POSTHOG_KEY
RUN npm run build

# ── runtime ──────────────────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production
# curl is needed for Coolify's container healthcheck (alpine ships without it).
# ffmpeg re-encodes WebM/Opus voice notes to AAC in the worker (Safari can't play Opus).
# chromium + fonts render books to PDF in the worker (lib/book-render.ts).
RUN apk add --no-cache curl ffmpeg chromium font-dejavu font-noto font-noto-emoji
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
COPY --from=build /app ./
RUN chmod +x ./docker-entrypoint.sh
EXPOSE 3000
CMD ["./docker-entrypoint.sh"]
