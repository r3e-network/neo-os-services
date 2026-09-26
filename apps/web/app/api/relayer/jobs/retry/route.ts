import { signManualAction } from '@r3e-network/neo-os-services-shared/node-runtime';
import { getServerSupabaseClient } from '@/lib/server-supabase';
import { resolveRequestNetwork } from '@/lib/request-network';
import { recordOperationLog } from '@/lib/operation-logs';
import { badRequest } from '@/lib/api-helpers';
import { logRelayerUnauthorized, requireRelayerAdmin } from '@/lib/relayer-auth';

export async function POST(request: Request) {
  const unauthorized = requireRelayerAdmin(request);
  const body = await request.json().catch(() => null);
  if (unauthorized) {
    await logRelayerUnauthorized('/api/relayer/jobs/retry', 'POST', body);
    return unauthorized;
  }

  const supabase = getServerSupabaseClient();
  if (!supabase) return badRequest('Supabase server configuration missing', 500);

  // SECURITY (S4): every manual action must carry an HMAC over the exact event
  // being retried, so an attacker who can write the jobs table cannot forge a
  // retry by editing the event payload. Fail closed when the secret is unset.
  const hmacSecret = (process.env.MORPHEUS_MANUAL_ACTION_HMAC_SECRET || '').trim();
  if (!hmacSecret) {
    return badRequest(
      'MORPHEUS_MANUAL_ACTION_HMAC_SECRET is not configured; manual retry is disabled',
      503
    );
  }

  const eventKey = typeof body?.event_key === 'string' ? body.event_key.trim() : '';
  const requestedNetwork = resolveRequestNetwork(String(body?.network || ''));
  if (!requestedNetwork.ok) return requestedNetwork.response;
  const network = requestedNetwork.network;
  if (!eventKey) return badRequest('event_key required');

  const { data: existing, error: existingError } = await supabase
    .from('morpheus_relayer_jobs')
    .select('id, event_key, status, event, worker_response')
    .eq('network', network)
    .eq('event_key', eventKey)
    .maybeSingle();

  if (existingError) return badRequest(existingError.message, 500);
  if (!existing) return badRequest(`job not found: ${eventKey}`, 404);
  if (!existing.event) return badRequest('job has no event payload to retry', 400);

  const action = 'manual_retry_requested';
  const manualActionSig = signManualAction(hmacSecret, action, network, eventKey, existing.event);
  const priorWorkerResponse =
    existing.worker_response && typeof existing.worker_response === 'object'
      ? (existing.worker_response as Record<string, unknown>)
      : {};

  const { error } = await supabase
    .from('morpheus_relayer_jobs')
    .update({
      status: action,
      next_retry_at: new Date().toISOString(),
      completed_at: null,
      worker_response: {
        ...priorWorkerResponse,
        manual_action_sig: manualActionSig,
      },
      updated_at: new Date().toISOString(),
    })
    .eq('network', network)
    .eq('event_key', eventKey);

  if (error) {
    await recordOperationLog({
      route: '/api/relayer/jobs/retry',
      method: 'POST',
      category: 'relayer',
      requestPayload: body,
      responsePayload: { error: error.message },
      httpStatus: 500,
      error: error.message,
    });
    return badRequest(error.message, 500);
  }
  const responseBody = { ok: true, network, event_key: eventKey, action: 'manual_retry_requested' };
  await recordOperationLog({
    route: '/api/relayer/jobs/retry',
    method: 'POST',
    category: 'relayer',
    requestPayload: body,
    responsePayload: responseBody,
    httpStatus: 200,
  });
  return Response.json(responseBody);
}
