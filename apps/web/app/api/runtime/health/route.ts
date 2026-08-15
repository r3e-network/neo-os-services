import { fetchBoxHealth, resolveRuntimeRequestNetwork } from '@/lib/runtime-health';

// Re-homed (2026-06): probe the attested in-TEE enclave /health directly instead of
// proxying the retired runtime gateway. Returns the box health body verbatim.
export async function GET(request: Request) {
  const network = resolveRuntimeRequestNetwork(request);
  const health = await fetchBoxHealth(network);
  return Response.json(health.body, {
    status: health.ok ? 200 : 503,
    headers: { 'cache-control': 'no-store' },
  });
}
