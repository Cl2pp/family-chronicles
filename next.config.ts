import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NextConfig } from 'next';

// Version-skew protection: without a deploymentId, PWA clients that keep an old
// bundle open across a redeploy call Server Actions whose IDs no longer exist
// ("Failed to find Server Action"). The Dockerfile writes .deployment-id before
// `next build`; the same file is read again by `next start`, so build and
// runtime always agree. Absent file (local dev) → no skew protection, which is fine.
function readDeploymentId(): string | undefined {
  if (process.env.NEXT_DEPLOYMENT_ID) return process.env.NEXT_DEPLOYMENT_ID;
  try {
    return readFileSync(join(__dirname, '.deployment-id'), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

const nextConfig: NextConfig = {
  // Pin the workspace root to this project (a stray parent lockfile otherwise
  // confuses Next's root inference).
  turbopack: {
    root: __dirname,
  },
  outputFileTracingRoot: __dirname,
  deploymentId: readDeploymentId(),
};

export default nextConfig;
