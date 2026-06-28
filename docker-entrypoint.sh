#!/bin/sh
# Same image runs either service; ROLE selects which.
#   ROLE=worker → background job worker
#   anything else (default) → the Next.js web server (runs DB migrations first)
set -e

if [ "$ROLE" = "worker" ]; then
  exec npm run worker
else
  # Web instance owns schema migrations; idempotent (drizzle tracks applied ones).
  npm run db:migrate
  exec npm run start
fi
