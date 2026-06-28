// Lightweight health check for Coolify / uptime monitoring.
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ status: 'ok' });
}
