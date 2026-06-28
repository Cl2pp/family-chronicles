#!/bin/sh
# Same image runs either service; ROLE selects which.
#   ROLE=worker → background job worker
#   anything else (default) → the Next.js web server
set -e

if [ "$ROLE" = "worker" ]; then
  exec npm run worker
else
  exec npm run start
fi
