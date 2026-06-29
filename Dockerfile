# Single image runs BOTH services; the ROLE env var selects which:
#   ROLE unset/anything → web  (npm run start)
#   ROLE=worker         → background job worker (npm run worker)
FROM node:22-alpine AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# ── deps ─────────────────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# ── build ────────────────────────────────────────────────────────────────────
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Real secrets aren't present at image-build time; skip env validation here.
ENV SKIP_ENV_VALIDATION=1
RUN npm run build

# ── runtime ──────────────────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production
# curl is needed for Coolify's container healthcheck (alpine ships without it).
RUN apk add --no-cache curl
COPY --from=build /app ./
RUN chmod +x ./docker-entrypoint.sh
EXPOSE 3000
CMD ["./docker-entrypoint.sh"]
