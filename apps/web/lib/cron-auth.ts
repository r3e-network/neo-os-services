import { timingSafeCompare } from '@r3e-network/neo-os-services-shared/utils';
import { isAuthorizedControlPlaneRequest } from './control-plane-auth';

// Mirrors the /api/cron/feed guard so every cron route demands the same
// credentials before doing cron-only work (e.g. BetterStack heartbeats):
// a public hit that fires the heartbeat would keep the cron-liveness monitor
// green even after the cron schedule breaks.

export function isAuthorizedCronSecretRequest(request: Request) {
  const runtimeEnv = process.env as Record<string, string | undefined>;
  // Vercel signs scheduled requests with CRON_SECRET, while operator probes
  // historically use MORPHEUS_CRON_SECRET. Accept both when configured so a
  // deployment that temporarily carries both names does not reject Vercel's
  // bearer token simply because the legacy secret is listed first.
  const configured = [runtimeEnv['MORPHEUS_CRON_SECRET'], runtimeEnv['CRON_SECRET']]
    .map((value) => (value || '').trim())
    .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index);
  if (configured.length === 0) return false;
  const bearer = request.headers.get('authorization') || '';
  const headerSecret =
    request.headers.get('x-morpheus-cron') || request.headers.get('x-cron-token') || '';
  return configured.some(
    (secret) =>
      timingSafeCompare(bearer, `Bearer ${secret}`) || timingSafeCompare(headerSecret, secret)
  );
}

export function isVercelCronUserAgentRequest(request: Request) {
  // The `vercel-cron` User-Agent is trivially spoofable, so it is only an
  // acceptable fallback in non-production environments. In production a real
  // shared secret (MORPHEUS_CRON_SECRET/CRON_SECRET) or an authorized
  // control-plane request is required.
  if (process.env.NODE_ENV === 'production') return false;
  const routeUrl = new URL(request.url);
  const userAgent = (request.headers.get('user-agent') || '').toLowerCase();
  return userAgent.includes('vercel-cron') && Array.from(routeUrl.searchParams.keys()).length === 0;
}

export function isAuthorizedCronRequest(request: Request) {
  return (
    isAuthorizedCronSecretRequest(request) ||
    isAuthorizedControlPlaneRequest(request) ||
    isVercelCronUserAgentRequest(request)
  );
}
