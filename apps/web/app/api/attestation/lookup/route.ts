import { getServerSupabaseClient } from '@/lib/server-supabase';
import {
  buildVerifierInput,
  extractEnvelopeByAttestationHash,
  normalizeHex,
} from '@/lib/attestation-lookup';
import { buildN3IndexFeedNotificationUrl } from '@/lib/n3index-feed';
import { recordOperationLog } from '@/lib/operation-logs';
import { getSelectedNetworkKey, networkRegistry, resolveSelectedNetworkKey } from '@/lib/networks';
import { publicApiHandler } from '@/lib/public-api-handler';

type OperationLogLookupRow = {
  route: string | null;
  category: string | null;
  created_at: string | null;
  http_status: number | null;
  request_id: string | null;
  target_chain: string | null;
  response_payload: unknown;
};

function decodeBase64Utf8(value: unknown) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    return Buffer.from(raw, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

async function lookupOperationLogs(attestationHash: string, networkKey: 'mainnet' | 'testnet') {
  const supabase = getServerSupabaseClient();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from('morpheus_operation_logs')
    .select('route, category, created_at, http_status, request_id, target_chain, response_payload')
    .eq('network', networkKey)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) throw error;

  const rows = (data as OperationLogLookupRow[] | null) || [];

  return rows
    .map((row) => {
      const envelope = extractEnvelopeByAttestationHash(row.response_payload, attestationHash);
      if (!envelope) return null;
      return {
        source: 'operation_log',
        route: row.route,
        category: row.category,
        created_at: row.created_at,
        http_status: row.http_status,
        request_id: row.request_id,
        target_chain: row.target_chain,
        verifier_input: buildVerifierInput(envelope, attestationHash),
      };
    })
    .filter(Boolean);
}

function buildFeedLookupUrl(networkKey: 'mainnet' | 'testnet') {
  const registry = networkRegistry[networkKey];
  const contractHash = String(registry.neo_n3?.contracts?.morpheus_datafeed || '').trim();
  if (!contractHash) return '';
  return buildN3IndexFeedNotificationUrl(networkKey, contractHash, 200);
}

async function lookupFeedNotifications(attestationHash: string, networkKey: 'mainnet' | 'testnet') {
  const lookupUrl = buildFeedLookupUrl(networkKey);
  if (!lookupUrl) return [];

  const response = await fetch(lookupUrl, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) return [];
  const body = await response.json().catch(() => []);
  if (!Array.isArray(body)) return [];

  const registry = networkRegistry[networkKey];
  const contractHash = String(registry.neo_n3?.contracts?.morpheus_datafeed || '').trim();
  return body
    .map((entry) => {
      if (String(entry?.contract_hash || '').toLowerCase() !== contractHash.toLowerCase()) {
        return null;
      }
      const state = entry?.state_json?.value;
      if (!Array.isArray(state) || state.length < 6) return null;
      const actualHash = normalizeHex(
        Buffer.from(String(state[4]?.value || ''), 'base64').toString('hex')
      );
      if (actualHash !== attestationHash) return null;
      return {
        source: 'neo_n3_feed',
        txid: entry.txid || null,
        block_index: entry.block_index || null,
        pair: decodeBase64Utf8(state[0]?.value),
        round_id: String(state[1]?.value || ''),
        price: String(state[2]?.value || ''),
        timestamp: String(state[3]?.value || ''),
        attestation_hash: `0x${actualHash}`,
      };
    })
    .filter(Boolean);
}

async function handleLookup(request: Request) {
  const url = new URL(request.url);
  const attestationHash = normalizeHex(url.searchParams.get('attestation_hash'));
  let networkKey: 'mainnet' | 'testnet';
  try {
    networkKey = resolveSelectedNetworkKey(
      url.searchParams.get('network') || getSelectedNetworkKey()
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'invalid network override' },
      { status: 400 }
    );
  }
  if (!attestationHash) {
    return Response.json({ error: 'attestation_hash query param is required' }, { status: 400 });
  }

  let operationMatches: unknown[] = [];
  let feedMatches: unknown[] = [];
  let lookupError: string | null = null;

  try {
    [operationMatches, feedMatches] = await Promise.all([
      lookupOperationLogs(attestationHash, networkKey),
      lookupFeedNotifications(attestationHash, networkKey),
    ]);
  } catch (error) {
    lookupError = error instanceof Error ? error.message : String(error);
  }

  const firstVerifierInput =
    (operationMatches as Array<{ verifier_input?: Record<string, unknown> }>).find(
      (entry) => entry?.verifier_input
    )?.verifier_input || null;

  const body = {
    ok: !lookupError,
    network: networkKey,
    attestation_hash: `0x${attestationHash}`,
    found: Boolean(firstVerifierInput || (feedMatches as unknown[]).length > 0),
    verifier_input: firstVerifierInput,
    operation_log_matches: operationMatches,
    onchain_feed_matches: feedMatches,
    error: lookupError,
  };

  await recordOperationLog({
    route: '/api/attestation/lookup',
    method: 'GET',
    category: 'attestation',
    requestPayload: Object.fromEntries(url.searchParams.entries()),
    responsePayload: body,
    httpStatus: lookupError ? 500 : 200,
    error: lookupError,
  });

  return Response.json(body, { status: lookupError ? 500 : 200 });
}

export const GET = publicApiHandler(handleLookup, {
  requireAuth: false,
  rateLimit: { scope: 'attestation-lookup', maxRequests: 30, windowMs: 60_000 },
});
