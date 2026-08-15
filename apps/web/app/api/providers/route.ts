import { badRequest } from '@/lib/api-helpers';
import { isKnownNetworkKey } from '@/lib/networks';
import { BUILTIN_PROVIDER_CATALOG } from '@/lib/provider-catalog';

function readNetwork(request: Request) {
  return new URL(request.url).searchParams.get('network');
}

// Re-homed (2026-06): the runtime's /providers handler is a fixed, secret-free,
// network-independent list (workers/nitro-worker/src/oracle/providers.js
// BUILTIN_PROVIDER_CATALOG), so apps/web serves it statically instead of proxying
// the retired runtime. The optional ?network validation is kept for parity/UX.
export async function GET(request: Request) {
  const network = readNetwork(request);
  if (network && !isKnownNetworkKey(network)) {
    return badRequest(`unknown network "${network}"; expected "mainnet" or "testnet"`);
  }
  return Response.json(
    { providers: BUILTIN_PROVIDER_CATALOG },
    { headers: { 'cache-control': 'public, max-age=300, stale-while-revalidate=600' } }
  );
}
