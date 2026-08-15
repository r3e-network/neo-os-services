import { getServerSupabaseClient, resolveSupabaseNetwork } from '@/lib/server-supabase';
import { recordOperationLog } from '@/lib/operation-logs';
import { badRequest } from '@/lib/api-helpers';
import { logRelayerUnauthorized, requireRelayerAdmin } from '@/lib/relayer-auth';

export async function GET(request: Request) {
  const unauthorized = requireRelayerAdmin(request);
  if (unauthorized) {
    await logRelayerUnauthorized(
      '/api/relayer/dead-letters',
      'GET',
      Object.fromEntries(new URL(request.url).searchParams.entries())
    );
    return unauthorized;
  }

  const supabase = getServerSupabaseClient();
  if (!supabase) return badRequest('Supabase server configuration missing', 500);

  const url = new URL(request.url);
  const limit = Math.max(Number(url.searchParams.get('limit') || 20), 1);
  const network = resolveSupabaseNetwork(url.searchParams.get('network'));

  const { data, error } = await supabase
    .from('morpheus_relayer_jobs')
    .select(
      'id, event_key, chain, request_id, request_type, tx_hash, block_number, route, status, attempts, last_error, worker_status, updated_at, completed_at, created_at'
    )
    .eq('network', network)
    .eq('status', 'exhausted')
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (error) {
    await recordOperationLog({
      route: '/api/relayer/dead-letters',
      method: 'GET',
      category: 'relayer',
      requestPayload: Object.fromEntries(url.searchParams.entries()),
      responsePayload: { error: error.message },
      httpStatus: 500,
      error: error.message,
    });
    return badRequest(error.message, 500);
  }
  const body = { network, dead_letters: data || [] };
  await recordOperationLog({
    route: '/api/relayer/dead-letters',
    method: 'GET',
    category: 'relayer',
    requestPayload: Object.fromEntries(url.searchParams.entries()),
    responsePayload: body,
    httpStatus: 200,
  });
  return Response.json(body);
}
