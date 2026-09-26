import { NEODID_SUPPORTED_PROVIDERS } from '@/lib/provider-catalog';

// Re-homed (2026-06): the runtime's /neodid/providers handler returns a fixed,
// secret-free identity-provider list (workers/nitro-worker/src/neodid/index.js
// SUPPORTED_PROVIDERS), so apps/web serves it statically instead of proxying the
// retired runtime.
export async function GET() {
  return Response.json(
    { providers: NEODID_SUPPORTED_PROVIDERS },
    { headers: { 'cache-control': 'public, max-age=300, stale-while-revalidate=600' } }
  );
}
