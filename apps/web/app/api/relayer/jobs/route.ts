import { getServerSupabaseClient } from '@/lib/server-supabase';
import { resolveRequestNetwork } from '@/lib/request-network';
import { recordOperationLog } from '@/lib/operation-logs';
import { badRequest } from '@/lib/api-helpers';
import { logRelayerUnauthorized, requireRelayerAdmin } from '@/lib/relayer-auth';

export async function GET(request: Request) {
  const unauthorized = requireRelayerAdmin(request);
  if (unauthorized) {
    await logRelayerUnauthorized(
      '/api/relayer/jobs',
      'GET',
      Object.fromEntries(new URL(request.url).searchParams.entries())
    );
    return unauthorized;
  }

  const supabase = getServerSupabaseClient();
  if (!supabase) return badRequest('Supabase server configuration missing', 500);

  const url = new URL(request.url);
  // SECURITY (S21): bound the page size so a crafted limit cannot request an
  // unbounded scan of the relayer jobs table.
  const rawLimit = Number(url.searchParams.get('limit') || 50);
  const limit = Math.min(Number.isFinite(rawLimit) ? Math.max(Math.trunc(rawLimit), 1) : 50, 200);
  const requestedNetwork = resolveRequestNetwork(url.searchParams.get('network'));
  if (!requestedNetwork.ok) return requestedNetwork.response;
  const network = requestedNetwork.network;
  const status = (url.searchParams.get('status') || '').trim();
  const chain = (url.searchParams.get('chain') || '').trim();

  let query = supabase
    .from('morpheus_relayer_jobs')
    .select(
      'id, event_key, chain, request_id, request_type, tx_hash, block_number, route, status, attempts, last_error, next_retry_at, worker_status, fulfill_tx, updated_at, completed_at, created_at'
    )
    .eq('network', network)
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (status) query = query.eq('status', status);
  if (chain) query = query.eq('chain', chain);

  const { data, error } = await query;
  if (error) {
    await recordOperationLog({
      route: '/api/relayer/jobs',
      method: 'GET',
      category: 'relayer',
      requestPayload: Object.fromEntries(url.searchParams.entries()),
      responsePayload: { error: error.message },
      httpStatus: 500,
      error: error.message,
    });
    return badRequest(error.message, 500);
  }
  const body = { network, jobs: data || [] };
  await recordOperationLog({
    route: '/api/relayer/jobs',
    method: 'GET',
    category: 'relayer',
    requestPayload: Object.fromEntries(url.searchParams.entries()),
    responsePayload: body,
    httpStatus: 200,
  });
  return Response.json(body);
}
