import { isKnownNetworkKey } from '@/lib/networks';
import { fetchOnchainState } from '@/lib/onchain-state';
import { recordOperationLog } from '@/lib/operation-logs';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get('limit') || '12');
  const network = url.searchParams.get('network');
  if (network && !isKnownNetworkKey(network)) {
    const body = { error: `unknown network "${network}"; expected "mainnet" or "testnet"` };
    await recordOperationLog({
      route: '/api/onchain/state',
      method: 'GET',
      category: 'network',
      requestPayload: { limit, network },
      responsePayload: body,
      httpStatus: 400,
      error: body.error,
    });
    return Response.json(body, { status: 400 });
  }
  const state = await fetchOnchainState(limit, network);
  // A chain-read failure must not masquerade as a healthy 200: status surfaces
  // and monitors key off the HTTP status and the ok flag.
  const chainError = state.neo_n3?.error || null;
  const httpStatus = chainError ? 503 : 200;
  const body = { ok: !chainError, ...state };
  await recordOperationLog({
    route: '/api/onchain/state',
    method: 'GET',
    category: 'network',
    requestPayload: { limit, network },
    responsePayload: body,
    httpStatus,
    error: chainError,
  });
  return Response.json(body, { status: httpStatus });
}
