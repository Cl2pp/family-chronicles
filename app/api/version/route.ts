import { NextResponse } from 'next/server';

// The DeploymentGuard polls this when the PWA returns to the foreground to
// detect that a redeploy happened while the page was backgrounded.
// Lives under /api/ on purpose: the service worker never intercepts /api/*.
export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json(
    // Next inlines this at build time with the configured deploymentId (from
    // next.config.ts), so it reports the id of the build serving traffic —
    // the same id the client received in data-dpl-id. null when unconfigured (dev).
    { deploymentId: process.env.NEXT_DEPLOYMENT_ID || null },
    { headers: { 'cache-control': 'no-store' } },
  );
}
