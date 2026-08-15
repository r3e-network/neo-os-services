import { KNOWN_FEED_PROVIDER_PREFIXES } from './feed-defaults';
import { getSelectedNetwork, getSelectedNetworkKey } from './networks';
import { trimString } from './strings';

type OnchainFeedRecord = {
  pair: string;
  round_id: string;
  price_units: string;
  price_display: string;
  price_scale: string;
  price_scale_decimals: number;
  timestamp: string;
  timestamp_iso: string | null;
  attestation_hash: string;
  source_set_id: string;
};

type OnchainOracleStatus = {
  contract: string;
  domain: string | null;
  request_fee_raw: string;
  request_fee_display: string;
  updater: string | null;
  verifier: string | null;
  encryption_algorithm: string | null;
  encryption_key_version: string;
  accrued_fees_raw: string;
};

type OnchainDatafeedStatus = {
  contract: string;
  domain: string | null;
  pair_count: number;
  records: OnchainFeedRecord[];
};

type ChainState = {
  oracle: OnchainOracleStatus | null;
  datafeed: OnchainDatafeedStatus | null;
  error: string | null;
};

const NEON3_GAS_DECIMALS = 8;
const PRICE_SCALE = 1_000_000;
const PRICE_DECIMALS = 6;

// The dashboard polls /api/onchain/state on an interval and each call fans out
// 7 Neo RPC reads; a short TTL collapses many concurrent clients onto a single
// chain read per (network, limit) window without surfacing stale data. Mirrors
// the server-side cache pattern in feeds-status.ts (getFeedsStatusBody).
const ONCHAIN_STATE_CACHE_TTL_MS = 12_000;

type OnchainStateBody = {
  network: string;
  generated_at: string;
  neo_n3: ChainState;
};

const onchainStateCache = new Map<string, { body: OnchainStateBody; expiresAt: number }>();

function isPrintableAscii(value: string) {
  return /^[\x09\x0a\x0d\x20-\x7e]*$/.test(value);
}

function decodeNeoByteString(bytes: Buffer) {
  const text = bytes.toString('utf8');
  const reversedText = Buffer.from(bytes).reverse().toString('utf8');

  if (
    isPrintableAscii(reversedText) &&
    KNOWN_FEED_PROVIDER_PREFIXES.some((prefix) => reversedText.startsWith(prefix))
  ) {
    return reversedText;
  }
  if (isPrintableAscii(text)) return text;
  if (isPrintableAscii(reversedText) && /^[A-Z0-9:_-]+$/.test(reversedText)) {
    return reversedText;
  }
  return `0x${bytes.toString('hex')}`;
}

function formatFixedPoint(rawValue: string | bigint, decimals: number) {
  const raw = String(rawValue ?? '0');
  const negative = raw.startsWith('-');
  const digits = raw.replace(/^[+-]/, '') || '0';
  const padded = digits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals) || '0';
  const fraction = padded.slice(-decimals);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

function toIsoTimestamp(value: string | number | bigint) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return new Date(numeric * 1000).toISOString();
}

function normalizeHashText(value: unknown) {
  const raw = trimString(value);
  if (!raw) return '';
  return raw.startsWith('0x') ? raw : `0x${raw}`;
}

function normalizeFeedRecord(record: {
  pair: unknown;
  roundId: unknown;
  price: unknown;
  timestamp: unknown;
  attestationHash: unknown;
  sourceSetId: unknown;
}): OnchainFeedRecord {
  const priceUnits = String(record.price ?? '0');
  const timestamp = String(record.timestamp ?? '0');
  return {
    pair: trimString(record.pair) || 'UNKNOWN',
    round_id: String(record.roundId ?? '0'),
    price_units: priceUnits,
    price_display: formatFixedPoint(priceUnits, PRICE_DECIMALS),
    price_scale: String(PRICE_SCALE),
    price_scale_decimals: PRICE_DECIMALS,
    timestamp,
    timestamp_iso: toIsoTimestamp(timestamp),
    attestation_hash: normalizeHashText(record.attestationHash),
    source_set_id: String(record.sourceSetId ?? '0'),
  };
}

export function parseNeoStackItem(item: any): unknown {
  if (!item || typeof item !== 'object') return null;
  const type = trimString(item.type).toLowerCase();

  switch (type) {
    case 'array':
    case 'struct':
      return Array.isArray(item.value)
        ? item.value.map((entry: unknown) => parseNeoStackItem(entry))
        : [];
    case 'string':
    case 'hash160':
    case 'hash256':
      return String(item.value ?? '');
    case 'integer':
      return String(item.value ?? '0');
    case 'boolean':
      return Boolean(item.value);
    case 'bytestring':
    case 'bytearray': {
      const raw = trimString(item.value);
      if (!raw) return '';
      const bytes = Buffer.from(raw, 'base64');
      const decoded = decodeNeoByteString(bytes);
      if (bytes.length === 20 && typeof decoded === 'string' && decoded.startsWith('0x')) {
        return `0x${Buffer.from(bytes).reverse().toString('hex')}`;
      }
      return decoded;
    }
    default:
      return item.value ?? null;
  }
}

async function fetchJsonRpc(url: string, body: Record<string, unknown>) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
    // Bound the request so a stalled Neo RPC endpoint cannot hang the
    // dashboard-polled /api/onchain path; callers already handle rejections.
    signal: AbortSignal.timeout(10000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      trimString(payload?.error?.message) ||
        trimString(payload?.message) ||
        `rpc request failed with status ${response.status}`
    );
  }
  if (payload?.error?.message) {
    throw new Error(payload.error.message);
  }
  return payload?.result;
}

export async function invokeNeoN3Read(
  rpcUrl: string,
  contractHash: string,
  method: string,
  params: unknown[] = []
) {
  const result = await fetchJsonRpc(rpcUrl, {
    jsonrpc: '2.0',
    id: 1,
    method: 'invokefunction',
    params: [contractHash, method, params],
  });
  if (String(result?.state || '').toUpperCase() === 'FAULT') {
    throw new Error(trimString(result?.exception) || `${method} faulted`);
  }
  return parseNeoStackItem(result?.stack?.[0]);
}

// The configured Neo N3 RPC candidates for a network, primary first, de-duped.
// config/networks/*.json carries an rpc_urls[] fallback list that the single-URL
// readers historically ignored — a public read path must iterate it because the
// primary (api.n3index.dev) is intermittently down (HTTP 521).
export function resolveNeoN3Rpcs(networkOverride?: string | null): string[] {
  const selected = getSelectedNetwork(networkOverride);
  const list = Array.isArray(selected.neo_n3?.rpc_urls) ? selected.neo_n3.rpc_urls : [];
  return [
    ...new Set([...list, selected.neo_n3?.rpc_url].map((u) => trimString(u)).filter(Boolean)),
  ];
}

// Read-only contract call over the RPC candidate list: a NETWORK error on one node
// fails over to the next; a contract HALT (incl. a HALT returning a null/Any value)
// or a deterministic FAULT returns/propagates from the first node that answered.
export async function readNeoN3Contract(
  networkOverride: string | null | undefined,
  contractHash: string,
  method: string,
  params: unknown[] = []
): Promise<unknown> {
  const rpcs = resolveNeoN3Rpcs(networkOverride);
  if (!rpcs.length) throw new Error('no Neo N3 RPC configured for the selected network');
  let lastError: unknown = null;
  for (const rpc of rpcs) {
    try {
      return await invokeNeoN3Read(rpc, contractHash, method, params);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'rpc read failed'));
}

async function fetchNeoN3State(
  rpcUrl: string,
  oracleHash: string,
  datafeedHash: string,
  limit: number,
  domains: { morpheus_oracle?: string; morpheus_datafeed?: string } = {}
): Promise<ChainState> {
  try {
    const [
      requestFee,
      updater,
      verifier,
      encryptionAlgorithm,
      encryptionKeyVersion,
      accruedFees,
      rawRecords,
    ] = await Promise.all([
      invokeNeoN3Read(rpcUrl, oracleHash, 'requestFee'),
      invokeNeoN3Read(rpcUrl, oracleHash, 'updater'),
      invokeNeoN3Read(rpcUrl, oracleHash, 'oracleVerificationPublicKey'),
      invokeNeoN3Read(rpcUrl, oracleHash, 'oracleEncryptionAlgorithm'),
      invokeNeoN3Read(rpcUrl, oracleHash, 'oracleEncryptionKeyVersion'),
      invokeNeoN3Read(rpcUrl, oracleHash, 'accruedRequestFees'),
      invokeNeoN3Read(rpcUrl, datafeedHash, 'getAllFeedRecords'),
    ]);

    const records = Array.isArray(rawRecords)
      ? (rawRecords
          .map((entry) => {
            if (!Array.isArray(entry) || entry.length < 6) return null;
            return normalizeFeedRecord({
              pair: entry[0],
              roundId: entry[1],
              price: entry[2],
              timestamp: entry[3],
              attestationHash: entry[4],
              sourceSetId: entry[5],
            });
          })
          .filter(Boolean) as OnchainFeedRecord[])
      : [];

    records.sort((left, right) => {
      const timestampDiff = Number(right.timestamp) - Number(left.timestamp);
      if (timestampDiff !== 0) return timestampDiff;
      return left.pair.localeCompare(right.pair);
    });

    return {
      oracle: {
        contract: oracleHash,
        domain: trimString(domains.morpheus_oracle) || null,
        request_fee_raw: String(requestFee ?? '0'),
        request_fee_display: `${formatFixedPoint(String(requestFee ?? '0'), NEON3_GAS_DECIMALS)} GAS`,
        updater: trimString(updater) || null,
        verifier: trimString(verifier) || null,
        encryption_algorithm: trimString(encryptionAlgorithm) || null,
        encryption_key_version: String(encryptionKeyVersion ?? '0'),
        accrued_fees_raw: String(accruedFees ?? '0'),
      },
      datafeed: {
        contract: datafeedHash,
        domain: trimString(domains.morpheus_datafeed) || null,
        pair_count: records.length,
        records: records.slice(0, limit),
      },
      error: null,
    };
  } catch (error) {
    return {
      oracle: null,
      datafeed: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function buildOnchainState(
  boundedLimit: number,
  networkOverride?: string | null
): Promise<OnchainStateBody> {
  const selected = getSelectedNetwork(networkOverride);

  // Iterate the RPC candidate list: a node outage (e.g. the primary api.n3index.dev
  // returning HTTP 521) fails over to the next instead of false-reporting the chain
  // as down. fetchNeoN3State catches per-node errors and returns {error}.
  const rpcs = resolveNeoN3Rpcs(networkOverride);
  const candidates = rpcs.length ? rpcs : [trimString(selected.neo_n3.rpc_url)];
  let neoN3 = await fetchNeoN3State(
    candidates[0],
    trimString(selected.neo_n3.contracts.morpheus_oracle),
    trimString(selected.neo_n3.contracts.morpheus_datafeed),
    boundedLimit,
    selected.neo_n3.domains || {}
  );
  for (let i = 1; i < candidates.length && neoN3.error; i += 1) {
    neoN3 = await fetchNeoN3State(
      candidates[i],
      trimString(selected.neo_n3.contracts.morpheus_oracle),
      trimString(selected.neo_n3.contracts.morpheus_datafeed),
      boundedLimit,
      selected.neo_n3.domains || {}
    );
  }

  return {
    network: trimString(selected.network) || 'testnet',
    generated_at: new Date().toISOString(),
    neo_n3: neoN3,
  };
}

export async function fetchOnchainState(limit = 12, networkOverride?: string | null) {
  const boundedLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), 200) : 12;
  // Resolve the override (which may be null/empty) to its concrete network key
  // so callers that differ only in how they spell the same network share a
  // cache entry; the key includes both the network and the bounded limit.
  const networkKey = getSelectedNetworkKey(networkOverride);
  const cacheKey = `${networkKey}:${boundedLimit}`;

  const now = Date.now();
  const cached = onchainStateCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.body;
  }

  const body = await buildOnchainState(boundedLimit, networkOverride);
  onchainStateCache.set(cacheKey, { body, expiresAt: now + ONCHAIN_STATE_CACHE_TTL_MS });
  return body;
}

export function resetOnchainStateCache() {
  onchainStateCache.clear();
}
