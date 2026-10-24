import { randomInt, randomUUID } from 'node:crypto';
import { sc, tx, u, wallet as neonWallet } from '@cityofzion/neon-js';
import {
  mapWithConcurrency,
  resolveScanConcurrency,
} from '@r3e-network/neo-os-services-shared/utils';
import { LEGACY_CALLBACK_METHOD } from '@r3e-network/neo-os-services-shared/callback-methods';
import {
  AUTOMATION_EXECUTION_QUEUE_METHOD,
  kernelManifestSupportsAutomationExecution,
  normalizeAutomationRegistrationRequestId,
  selectAutomationQueueLane,
} from '@r3e-network/neo-os-services-shared/automation-supervisor';
import { custodyKeyId, custodyKeyInfo, custodySignTransaction } from './custody.js';
import { strip0x as stripHexPrefix, trimString } from './lib/strings.js';
import { requireRawPayloadHex } from './lib/payload.js';

// Identifier hygiene: event identifier fields must carry the on-chain bytes
// VERBATIM (no trimming) so fulfillment digests reproduce exactly what the
// kernel hashes and ingestion can detect whitespace-bearing identifiers. This
// helper only coerces non-string decode artifacts to '' for emptiness gates.
function asEventString(value) {
  return typeof value === 'string' ? value : '';
}

// Neo N3 script hashes, public keys and signatures are compared and rendered
// case-insensitively here, so fold to lower-case after stripping the shared 0x
// primitive. Keeping the local `strip0x` name means every call site below is
// unchanged; only the prefix-stripping logic is now single-sourced.
function strip0x(value) {
  return stripHexPrefix(value).toLowerCase();
}

function tryDecodeUtf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function isPrintableText(text) {
  return typeof text === 'string' && /^[\x09\x0a\x0d\x20-\x7e]*$/.test(text);
}

const RPC_TIMEOUT_MS = 30_000;
const GAS_CONTRACT_HASH = '0xd2a4cff31913016155e38e474a2c06d08be276cf';
const DEFAULT_FEE_TOP_UP_MIN_BALANCE = 50_000_000n; // 0.5 GAS
const DEFAULT_FEE_TOP_UP_AMOUNT = 100_000_000n; // 1 GAS
const DEFAULT_FEE_TOP_UP_MAX_AMOUNT = 500_000_000n; // 5 GAS

function uniqueOrdered(values) {
  return [...new Set(values.map((entry) => trimString(entry)).filter(Boolean))];
}

function getNeoN3RpcUrls(configOrRpcUrl) {
  if (typeof configOrRpcUrl === 'string') return uniqueOrdered([configOrRpcUrl]);
  return uniqueOrdered([
    trimString(configOrRpcUrl?.neo_n3?.rpcUrl || ''),
    ...(Array.isArray(configOrRpcUrl?.neo_n3?.rpcUrls) ? configOrRpcUrl.neo_n3.rpcUrls : []),
  ]);
}

// Move a known-good RPC URL to the front of the configured list so the next call
// tries it first (a simple health-stickiness heuristic). This is a best-effort
// optimization, NOT a consistency-critical write:
//   - Under the bounded in-block/scan concurrency (scanNeoN3OracleRequestBlock,
//     scanNeoN3OracleRequests) several successful neoRpcCall invocations may run
//     promoteNeoN3RpcUrl concurrently. They race on config.neo_n3.rpcUrl/rpcUrls,
//     so one update can clobber another (last-write-wins). That is acceptable
//     because every promoted URL is one that just succeeded, so any winning order
//     is still a valid, healthy ordering — no result is corrupted, and a transient
//     sub-optimal order self-corrects on the next successful call.
// Do not make this write load-bearing; if a future change needs the list order to
// be stable across concurrent reads, snapshot getNeoN3RpcUrls once per call
// instead of mutating here.
function promoteNeoN3RpcUrl(config, rpcUrl) {
  const nextUrl = trimString(rpcUrl);
  if (!nextUrl || !config?.neo_n3) return;
  config.neo_n3.rpcUrl = nextUrl;
  config.neo_n3.rpcUrls = uniqueOrdered([nextUrl, ...(config.neo_n3.rpcUrls || [])]);
}

function createNeoRpcError(rpcUrl, method, status, detail) {
  const suffix = trimString(detail);
  return new Error(
    `Neo RPC ${method} failed via ${rpcUrl} (${status})${suffix ? `: ${suffix}` : ''}`
  );
}

async function neoRpcCall(configOrRpcUrl, method, params = []) {
  const rpcUrls = getNeoN3RpcUrls(configOrRpcUrl);
  if (rpcUrls.length === 0) {
    throw new Error(`Neo RPC ${method} failed: no RPC endpoint configured`);
  }

  let lastError = null;
  for (const rpcUrl of rpcUrls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: controller.signal,
      });
      const rawBody = await response.text();
      let body;
      try {
        body = JSON.parse(rawBody);
      } catch {
        throw createNeoRpcError(rpcUrl, method, response.status, 'non-JSON response');
      }
      if (!response.ok) {
        throw createNeoRpcError(
          rpcUrl,
          method,
          response.status,
          body?.error?.message || body?.message || response.statusText
        );
      }
      if (body?.error) {
        throw createNeoRpcError(rpcUrl, method, 200, body.error.message || `${method} failed`);
      }
      if (typeof configOrRpcUrl === 'object') {
        promoteNeoN3RpcUrl(configOrRpcUrl, rpcUrl);
      }
      return body.result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error(`Neo RPC ${method} failed`);
}

// Decode a hex ByteString (caller has already confirmed it looks-hex): printable
// UTF-8 if it round-trips, else a reversed 0x-hash for 20-byte values, else raw utf8.
function decodeByteStringFromHex(raw) {
  const bytes = Buffer.from(raw, 'hex');
  const text = tryDecodeUtf8(bytes);
  if (isPrintableText(text)) return text;
  if (raw.length === 40) return `0x${bytes.reverse().toString('hex')}`;
  try {
    return bytes.toString('utf8');
  } catch {
    return raw;
  }
}

// Decode a base64 ByteString: printable UTF-8 if it round-trips, else a reversed
// 0x-hash for 20-byte values, else raw utf8; returns the input on any decode error.
function decodeByteStringFromBase64(raw) {
  try {
    const bytes = Buffer.from(raw, 'base64');
    const text = tryDecodeUtf8(bytes);
    if (isPrintableText(text)) return text;
    if (bytes.length === 20) {
      return `0x${Buffer.from(bytes).reverse().toString('hex')}`;
    }
    return bytes.toString('utf8');
  } catch {
    return raw;
  }
}

function rawNeoPayloadHex(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error('Neo N3 request payload stack item is missing');
  }
  const type = trimString(item.type).toLowerCase();
  if (type !== 'bytestring' && type !== 'bytearray') {
    throw new Error('Neo N3 request payload must be a ByteString');
  }
  if (typeof item.value !== 'string') {
    throw new Error('Neo N3 request payload ByteString value is missing');
  }
  const raw = item.value.trim();
  if (!raw) return '0x';
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.toString('base64') !== raw) {
    throw new Error('Neo N3 request payload ByteString is not canonical base64');
  }
  return bytes.toString('hex');
}

// Decode a Neo VM stack/notification item. `encoding` pins how ByteString /
// ByteArray values are encoded by the source: Neo JSON-RPC and n3index both
// emit base64, so all in-repo call sites pass 'base64'. The 'auto' default
// keeps the legacy hex-vs-base64 sniffing only as a last resort for sources
// whose encoding is unknown — a base64 payload made entirely of hex characters
// (e.g. 'abcd') would otherwise be mis-decoded as hex.
export function decodeNeoItem(item, encoding = 'auto') {
  if (!item || typeof item !== 'object') return null;
  const type = trimString(item.type).toLowerCase();
  switch (type) {
    case 'integer':
      return String(item.value ?? '0');
    case 'string':
      return String(item.value ?? '');
    case 'boolean':
      return Boolean(item.value);
    case 'hash160':
    case 'hash256':
      return String(item.value ?? '');
    case 'bytestring':
    case 'bytearray': {
      const raw = trimString(item.value);
      if (!raw) return '';
      const looksHex = /^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0;
      if (encoding === 'hex' || (encoding !== 'base64' && looksHex)) {
        return looksHex ? decodeByteStringFromHex(raw) : raw;
      }
      return decodeByteStringFromBase64(raw);
    }
    case 'array':
    case 'struct':
      return Array.isArray(item.value)
        ? item.value.map((entry) => decodeNeoItem(entry, encoding))
        : [];
    default:
      return item.value ?? null;
  }
}

export function hasNeoN3RelayerConfig(config) {
  return Boolean(
    getNeoN3RpcUrls(config).length > 0 &&
    config.neo_n3.oracleContract &&
    trimString(config?.neo_n3?.custodyKeyIds?.updater || '')
  );
}

export async function getNeoN3LatestBlock(config) {
  const blockCount = await neoRpcCall(config, 'getblockcount');
  return Number(blockCount) - 1;
}

export async function getNeoN3IndexedBlock(config) {
  const network = trimString(config.network) === 'mainnet' ? 'mainnet' : 'testnet';
  const baseUrl = trimString(config.neo_n3.indexerUrl || 'https://api.n3index.dev/rest/v1').replace(
    /\/$/,
    ''
  );
  const url = new URL(`${baseUrl}/indexer_state`);
  url.searchParams.set('network', `eq.${network}`);
  url.searchParams.set('select', 'last_indexed_block');
  url.searchParams.set('limit', '1');

  const response = await fetch(url.toString(), {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`n3index indexer_state failed: ${response.status} ${text}`.trim());
  }

  const rows = await response.json().catch(() => []);
  const latest = Array.isArray(rows) ? Number(rows[0]?.last_indexed_block || 0) : 0;
  if (!Number.isFinite(latest) || latest <= 0) {
    throw new Error('n3index last_indexed_block unavailable');
  }
  return latest;
}

export async function getNeoN3LatestRequestId(config) {
  const result = await neoRpcCall(config, 'invokefunction', [
    config.neo_n3.oracleContract,
    'getTotalRequests',
    [],
  ]);
  if (String(result?.state || '').toUpperCase() === 'FAULT') {
    throw new Error(result?.exception || 'Neo N3 getTotalRequests faulted');
  }
  return Number(decodeNeoItem(result?.stack?.[0], 'base64') || '0');
}

export function buildNeoN3RelayRequestId(scope, requestId) {
  const normalizedScope = trimString(scope) || 'invoke';
  return `relayer:n3:${normalizedScope}:${requestId}:${randomUUID()}`;
}

export function buildNeoN3EventFromRequestRecord(decoded, requestId, payloadHex) {
  if (!Array.isArray(decoded)) return null;

  if (decoded.length >= 14) {
    const [
      requestIdValue,
      appId,
      moduleId,
      operation,
      payloadText,
      requester,
      ,
      callbackContract,
      ,
      createdAtMs,
      fulfilledAtMs,
      ,
      resultText,
      errorText,
    ] = decoded;

    if (!asEventString(operation)) return null;

    const alreadySettled = trimString(fulfilledAtMs) !== '' && trimString(fulfilledAtMs) !== '0';
    const hasOutcome = trimString(resultText) !== '' || trimString(errorText) !== '';
    if (alreadySettled || hasOutcome) return null;

    return {
      chain: 'neo_n3',
      requestId: String(requestIdValue || requestId),
      requestType: String(operation || ''),
      appId: String(appId || ''),
      moduleId: String(moduleId || ''),
      operation: String(operation || ''),
      requester: String(requester || ''),
      callbackContract: String(callbackContract || ''),
      callbackMethod: LEGACY_CALLBACK_METHOD,
      payloadText: String(payloadText || ''),
      payloadHex: requireRawPayloadHex({ payloadHex }),
      createdAtMs: Number(createdAtMs || 0),
      fulfilledAtMs: Number(fulfilledAtMs || 0),
      blockNumber: Number(createdAtMs || 0),
      txHash: '',
      logIndex: 0,
    };
  }

  if (decoded.length >= 12) {
    const [
      requestIdValue,
      requestType,
      payloadText,
      callbackContract,
      callbackMethod,
      requester,
      ,
      createdAtMs,
      fulfilledAtMs,
      ,
      resultText,
      errorText,
    ] = decoded;

    if (!asEventString(requestType)) return null;

    const alreadySettled = trimString(fulfilledAtMs) !== '' && trimString(fulfilledAtMs) !== '0';
    const hasOutcome = trimString(resultText) !== '' || trimString(errorText) !== '';
    if (alreadySettled || hasOutcome) return null;

    return {
      chain: 'neo_n3',
      requestId: String(requestIdValue || requestId),
      requestType: String(requestType || ''),
      requester: String(requester || ''),
      callbackContract: String(callbackContract || ''),
      callbackMethod: String(callbackMethod || ''),
      payloadText: String(payloadText || ''),
      payloadHex: requireRawPayloadHex({ payloadHex }),
      createdAtMs: Number(createdAtMs || 0),
      fulfilledAtMs: Number(fulfilledAtMs || 0),
      blockNumber: Number(createdAtMs || 0),
      txHash: '',
      logIndex: 0,
    };
  }

  return null;
}

// Event names emitted by the oracle request entry points. The current kernel
// contract (MorpheusOracle) emits `MiniAppRequestQueued`; legacy oracle
// contracts emit `OracleRequested`. The relayer accepts both so a single
// notification/block-cursor scan works against either deployment.
const NEO_N3_REQUEST_EVENT_NAMES = new Set(['MiniAppRequestQueued', 'OracleRequested']);

/**
 * Normalize a Neo N3 request notification into the internal event shape used by
 * the fulfillment pipeline. The two supported events have different state
 * layouts:
 *   - MiniAppRequestQueued: [requestId, appId, moduleId, operation, requester,
 *       sponsor, payload] (kernel contract). `requestType` is the operation so
 *       it matches the working `request_cursor` path which derives the kernel
 *       intent from `operation`.
 *   - OracleRequested: [requestId, requestType, requester, callbackContract,
 *       callbackMethod, payload] (legacy contract).
 * Returns null when the event name is unknown or the decoded state is empty.
 */
function buildNeoN3EventFromNotificationState(eventName, decodedState, meta = {}) {
  const state = Array.isArray(decodedState) ? decodedState : [];
  if (eventName === 'MiniAppRequestQueued') {
    const [requestId, appId, moduleId, operation, requester, , payload] = state;
    if (!asEventString(operation)) return null;
    return {
      chain: 'neo_n3',
      requestId: String(requestId || '0'),
      requestType: String(operation || ''),
      appId: String(appId || ''),
      moduleId: String(moduleId || ''),
      operation: String(operation || ''),
      requester: String(requester || ''),
      callbackContract: '',
      callbackMethod: LEGACY_CALLBACK_METHOD,
      payloadText: String(payload || ''),
      payloadHex: requireRawPayloadHex({ payloadHex: meta.payloadHex }),
      blockNumber: Number(meta.blockNumber ?? 0),
      txHash: String(meta.txHash || ''),
      ...(meta.logIndex !== undefined ? { logIndex: Number(meta.logIndex) } : {}),
    };
  }
  if (eventName === 'OracleRequested') {
    const [requestId, requestType, requester, callbackContract, callbackMethod, payload] = state;
    if (!asEventString(requestType)) return null;
    return {
      chain: 'neo_n3',
      requestId: String(requestId || '0'),
      requestType: String(requestType || ''),
      requester: String(requester || ''),
      callbackContract: String(callbackContract || ''),
      callbackMethod: String(callbackMethod || ''),
      payloadText: String(payload || ''),
      payloadHex: requireRawPayloadHex({ payloadHex: meta.payloadHex }),
      blockNumber: Number(meta.blockNumber ?? 0),
      txHash: String(meta.txHash || ''),
      ...(meta.logIndex !== undefined ? { logIndex: Number(meta.logIndex) } : {}),
    };
  }
  return null;
}

// Per-block in-flight cap for the independent getapplicationlog reads (see the
// note in scanNeoN3OracleRequestBlock). Kept small so the total in-flight —
// bounded by the block-level concurrency (resolveScanConcurrency, <= 8) times
// this — does not overwhelm the RPC node; operators hitting rate limits can lower
// config.concurrency.
const IN_BLOCK_APPLOG_CONCURRENCY = 4;

// Scan a single block's transactions for oracle request notifications. Keeps
// the per-tx getapplicationlog read (the only source of execution
// notifications on Neo N3 — getblock verbose returns headers + tx bodies, not
// notifications) and preserves the in-block ordering (tx order, then execution
// order, then notification index) so the returned slice matches the sequential
// scan exactly.
async function scanNeoN3OracleRequestBlock(config, height, targetContract) {
  const events = [];
  const block = await neoRpcCall(config, 'getblock', [height, 1]);
  const transactions = Array.isArray(block?.tx) ? block.tx : [];
  // The per-tx getapplicationlog reads are independent, so fetch them under a
  // small bounded concurrency instead of serially (a per-block N+1).
  // mapWithConcurrency preserves input order and rejects on the first error, so
  // the in-block ordering AND the fail-fast cursor safety are both unchanged.
  const txHashes = transactions
    .map((transaction) => transaction.txid || transaction.hash)
    .filter(Boolean);
  const appLogs = await mapWithConcurrency(txHashes, IN_BLOCK_APPLOG_CONCURRENCY, (txHash) =>
    neoRpcCall(config, 'getapplicationlog', [txHash])
  );
  for (let txIndex = 0; txIndex < txHashes.length; txIndex += 1) {
    const txHash = txHashes[txIndex];
    const appLog = appLogs[txIndex];
    const executions = Array.isArray(appLog?.executions) ? appLog.executions : [];
    for (const execution of executions) {
      const notifications = Array.isArray(execution?.notifications) ? execution.notifications : [];
      let logIndex = 0;
      for (const notification of notifications) {
        const notificationIndex = logIndex;
        logIndex += 1;
        if (strip0x(notification.contract) !== targetContract) continue;
        const eventName = trimString(notification.eventname);
        if (!NEO_N3_REQUEST_EVENT_NAMES.has(eventName)) continue;
        const state = Array.isArray(notification.state?.value) ? notification.state.value : [];
        const decodedState = state.map((entry) => decodeNeoItem(entry, 'base64'));
        const event = buildNeoN3EventFromNotificationState(eventName, decodedState, {
          blockNumber: height,
          txHash,
          logIndex: notificationIndex,
          payloadHex: rawNeoPayloadHex(state[eventName === 'MiniAppRequestQueued' ? 6 : 5]),
        });
        if (event) events.push(event);
      }
    }
  }
  return events;
}

export async function scanNeoN3OracleRequests(config, fromBlock, toBlock) {
  if (fromBlock > toBlock) return [];
  const targetContract = strip0x(config.neo_n3.oracleContract);

  // Batch the per-block scans under bounded concurrency. Results are
  // index-ordered (ascending block height) and each block keeps its internal
  // ordering, so flattening reproduces the sequential scan exactly. Any FAULT
  // or transport error still rejects the whole scan (fail-fast) so the block
  // cursor never advances past an unscanned height.
  const heights = [];
  for (let height = fromBlock; height <= toBlock; height += 1) {
    heights.push(height);
  }
  const perBlockEvents = await mapWithConcurrency(
    heights,
    resolveScanConcurrency(config),
    (height) => scanNeoN3OracleRequestBlock(config, height, targetContract)
  );

  return perBlockEvents.flat();
}

export async function scanNeoN3OracleRequestsViaN3Index(config, fromBlock, toBlock) {
  if (fromBlock > toBlock) return [];
  const network = trimString(config.network) === 'mainnet' ? 'mainnet' : 'testnet';
  const baseUrl = trimString(config.neo_n3.indexerUrl || 'https://api.n3index.dev/rest/v1').replace(
    /\/$/,
    ''
  );
  const url = new URL(`${baseUrl}/contract_notifications`);
  url.searchParams.set('network', `eq.${network}`);
  url.searchParams.set('contract_hash', `eq.${config.neo_n3.oracleContract}`);
  // Accept both the current kernel event and the legacy oracle event.
  url.searchParams.set('event_name', `in.(${[...NEO_N3_REQUEST_EVENT_NAMES].join(',')})`);
  url.searchParams.set('order', 'block_index.desc');
  url.searchParams.set('limit', String(Math.max(config.maxBlocksPerTick * 4, 500)));

  const response = await fetch(url.toString(), {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`n3index oracle request scan failed: ${response.status} ${text}`.trim());
  }

  const rows = await response.json().catch(() => []);
  if (!Array.isArray(rows)) return [];

  return rows
    .filter((row) => {
      const blockIndex = Number(row?.block_index || 0);
      return blockIndex >= fromBlock && blockIndex <= toBlock;
    })
    .sort((left, right) => {
      const leftBlock = Number(left?.block_index || 0);
      const rightBlock = Number(right?.block_index || 0);
      if (leftBlock !== rightBlock) return leftBlock - rightBlock;
      return Number(left?.notification_index || 0) - Number(right?.notification_index || 0);
    })
    .map((row) => {
      const state = Array.isArray(row?.state_json?.value)
        ? row.state_json.value
        : Array.isArray(row?.raw_json?.state?.value)
          ? row.raw_json.state.value
          : [];
      // n3index serves state_json/raw_json values base64-encoded, mirroring the
      // node's JSON-RPC notification format.
      const decodedState = state.map((entry) => decodeNeoItem(entry, 'base64'));
      const eventName = trimString(row?.event_name);
      if (!NEO_N3_REQUEST_EVENT_NAMES.has(eventName)) return null;
      return buildNeoN3EventFromNotificationState(eventName, decodedState, {
        blockNumber: Number(row?.block_index || 0),
        txHash: String(row?.txid || ''),
        logIndex: Number(row?.notification_index || 0),
        payloadHex: rawNeoPayloadHex(state[eventName === 'MiniAppRequestQueued' ? 6 : 5]),
      });
    })
    .filter((event) => event && asEventString(event.requestType));
}

export async function scanNeoN3OracleRequestsById(config, fromRequestId, toRequestId) {
  if (fromRequestId > toRequestId) return [];

  // Batch the per-id getRequest lookups under bounded concurrency. Results are
  // index-ordered, so the returned events match the sequential scan exactly
  // (ascending request id); any FAULT or transport error still rejects the whole
  // scan so the request cursor never advances past an unscanned id.
  const requestIds = [];
  for (let requestId = fromRequestId; requestId <= toRequestId; requestId += 1) {
    requestIds.push(requestId);
  }
  const events = await mapWithConcurrency(
    requestIds,
    resolveScanConcurrency(config),
    async (requestId) => {
      const result = await neoRpcCall(config, 'invokefunction', [
        config.neo_n3.oracleContract,
        'getRequest',
        [{ type: 'Integer', value: String(requestId) }],
      ]);
      if (String(result?.state || '').toUpperCase() === 'FAULT') {
        throw new Error(result?.exception || `Neo N3 getRequest faulted for request ${requestId}`);
      }
      const decoded = decodeNeoItem(result?.stack?.[0], 'base64');
      const payloadIndex = Array.isArray(decoded) && decoded.length >= 14 ? 4 : 2;
      return buildNeoN3EventFromRequestRecord(
        decoded,
        requestId,
        rawNeoPayloadHex(result?.stack?.[0]?.value?.[payloadIndex])
      );
    }
  );

  return events.filter(Boolean);
}

export function encodeUtf8ByteArrayParamValue(value) {
  const raw = trimString(value);
  if (!raw) return '';
  return Buffer.from(raw, 'utf8').toString('base64');
}

function base64ToHex(value) {
  const raw = trimString(value);
  if (!raw) return '';
  return Buffer.from(raw, 'base64').toString('hex');
}

function normalizePublicKey(value) {
  const publicKey = strip0x(value);
  if (!/^[0-9a-f]{66}$/i.test(publicKey) && !/^[0-9a-f]{130}$/i.test(publicKey)) {
    throw new Error('runtime derived updater returned an invalid public key');
  }
  return publicKey;
}

function normalizeHash160(value) {
  const raw = trimString(value);
  if (/^0x[0-9a-f]{40}$/i.test(raw)) return raw.toLowerCase();
  if (/^[0-9a-f]{40}$/i.test(raw)) return `0x${raw.toLowerCase()}`;
  try {
    return `0x${neonWallet.getScriptHashFromAddress(raw)}`.toLowerCase();
  } catch {
    return '';
  }
}

function parseNonNegativeBigInt(value, fallback) {
  const raw = trimString(value);
  if (!/^[0-9]+$/.test(raw)) return fallback;
  return BigInt(raw);
}

function getNeoN3FeeTopUpSettings(config) {
  const raw = config?.neo_n3?.feeTopUp || {};
  if (!raw.enabled) return { enabled: false };
  return {
    enabled: true,
    minBalance: parseNonNegativeBigInt(raw.minBalance, DEFAULT_FEE_TOP_UP_MIN_BALANCE),
    topUpAmount: parseNonNegativeBigInt(raw.topUpAmount, DEFAULT_FEE_TOP_UP_AMOUNT),
    maxTopUpAmount: parseNonNegativeBigInt(raw.maxTopUpAmount, DEFAULT_FEE_TOP_UP_MAX_AMOUNT),
  };
}

async function readNeoN3GasBalance(config, scriptHash) {
  const normalized = normalizeHash160(scriptHash);
  if (!normalized) throw new Error('Neo N3 GAS balance read failed: invalid account');
  const result = await neoRpcCall(config, 'invokefunction', [
    GAS_CONTRACT_HASH,
    'balanceOf',
    [{ type: 'Hash160', value: normalized }],
  ]);
  if (String(result?.state || '').toUpperCase() === 'FAULT') {
    throw new Error(result?.exception || 'Neo N3 GAS balance read faulted');
  }
  return BigInt(decodeNeoItem(result?.stack?.[0], 'base64') || '0');
}

async function waitForNeoN3TransactionHalt(config, txHash, label) {
  const deadline = Date.now() + Number(config?.neo_n3?.feeTopUp?.waitTimeoutMs || 45_000);
  let lastError = null;
  let fatalError = null;
  while (Date.now() < deadline) {
    try {
      const appLog = await neoRpcCall(config, 'getapplicationlog', [txHash]);
      const execution = appLog?.executions?.[0];
      const vmState = trimString(execution?.vmstate || '').toUpperCase();
      if (vmState === 'HALT') return;
      if (vmState) {
        fatalError = new Error(
          `${label} faulted (${txHash}): ${execution?.exception || vmState || 'unknown error'}`
        );
        break;
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (fatalError) throw fatalError;
  throw new Error(
    `${label} was not confirmed before timeout (${txHash})${
      lastError?.message ? `: ${lastError.message}` : ''
    }`
  );
}

// Fee shaping for locally-built Neo N3 transactions (raw GAS fractions,
// 8 decimals): every fee gets a flat safety pad, and runtime-signed
// transactions add 20% system-fee headroom on top of the simulated cost.
const NEO_N3_TX_VALID_BLOCKS = 120;
const NEO_N3_FEE_PADDING = 100000n; // 0.001 GAS pad on system and network fees
const NEO_N3_SYSTEM_FEE_HEADROOM_DIVISOR = 5n; // +20% simulated-cost headroom

/**
 * Build, fee, sign, and broadcast a Neo N3 transaction for `script`.
 *
 * `signerAdapter` supplies the witness strategy:
 * - `scriptHash`: the sender account (with or without 0x prefix).
 * - `sign(transaction)`: attach witnesses. Called twice — once before
 *   calculatenetworkfee so the fee covers witness size, and again after the
 *   network fee lands on the transaction.
 * - `verifyWitness(transaction)` (optional): post-sign assertion hook.
 *
 * Options:
 * - `label`: prefix for the default test-invoke FAULT error message.
 * - `buildTestInvokeFaultError(exception)`: site-specific FAULT message.
 * - `systemFeeHeadroom`: add the 20% headroom used by runtime-signed paths.
 * - `ensureFeeBalance(requiredFee)` (optional): awaited with the total fee
 *   (system + network + padding) before the final signature.
 *
 * Resolves `{ txHash, signedBase64, transaction }` after sendrawtransaction
 * accepts the broadcast; confirmation polling stays with the callers.
 */
export async function buildSignAndBroadcastNeoN3Tx(config, script, signerAdapter, options = {}) {
  const label = trimString(options.label) || 'Neo N3 transaction';
  const signerAccount = strip0x(signerAdapter.scriptHash);
  const blockCount = Number(await neoRpcCall(config, 'getblockcount'));
  const transaction = new tx.Transaction({
    version: 0,
    // SECURITY (S20): use a CSPRNG for the transaction nonce, not Math.random.
    nonce: randomInt(0, 2 ** 32),
    script: u.HexString.fromHex(script),
    validUntilBlock: blockCount + NEO_N3_TX_VALID_BLOCKS,
    signers: [{ account: signerAccount, scopes: tx.WitnessScope.CalledByEntry }],
    attributes: [],
    witnesses: [],
  });

  const testInvoke = await neoRpcCall(config, 'invokescript', [
    transaction.script.toBase64(),
    [{ account: signerAccount, scopes: 'CalledByEntry' }],
  ]);
  if (String(testInvoke?.state || '').toUpperCase() === 'FAULT') {
    const exception = testInvoke?.exception;
    throw new Error(
      typeof options.buildTestInvokeFaultError === 'function'
        ? options.buildTestInvokeFaultError(exception)
        : `${label} test invoke faulted: ${exception || 'unknown error'}`
    );
  }

  const gasConsumed = BigInt(testInvoke?.gasconsumed || testInvoke?.gas_consumed || '0');
  const systemFee = options.systemFeeHeadroom
    ? gasConsumed + gasConsumed / NEO_N3_SYSTEM_FEE_HEADROOM_DIVISOR + NEO_N3_FEE_PADDING
    : gasConsumed + NEO_N3_FEE_PADDING;
  transaction.systemFee = u.BigInteger.fromDecimal(String(systemFee), 0);

  await signerAdapter.sign(transaction);
  const networkFeeResponse = await neoRpcCall(config, 'calculatenetworkfee', [
    Buffer.from(transaction.serialize(true), 'hex').toString('base64'),
  ]);
  const networkFeeRaw =
    typeof networkFeeResponse === 'string'
      ? networkFeeResponse
      : networkFeeResponse?.networkfee || networkFeeResponse?.network_fee || '0';
  transaction.networkFee = u.BigInteger.fromDecimal(
    String(BigInt(networkFeeRaw || '0') + NEO_N3_FEE_PADDING),
    0
  );
  if (typeof options.ensureFeeBalance === 'function') {
    await options.ensureFeeBalance(systemFee + BigInt(networkFeeRaw || '0') + NEO_N3_FEE_PADDING);
  }

  await signerAdapter.sign(transaction);
  if (typeof signerAdapter.verifyWitness === 'function') {
    signerAdapter.verifyWitness(transaction);
  }

  const txHash = `0x${transaction.hash()}`;
  const signedBase64 = Buffer.from(transaction.serialize(true), 'hex').toString('base64');
  await neoRpcCall(config, 'sendrawtransaction', [signedBase64]);
  return { txHash, signedBase64, transaction };
}

async function sendNeoN3GasTransfer(config, funder, toScriptHash, amount) {
  const to = normalizeHash160(toScriptHash);
  const script = sc.createScript({
    scriptHash: strip0x(GAS_CONTRACT_HASH),
    operation: 'transfer',
    args: [
      sc.ContractParam.hash160(`0x${strip0x(funder.scriptHash)}`),
      sc.ContractParam.hash160(to),
      sc.ContractParam.integer(String(amount)),
      sc.ContractParam.any(null),
    ],
  });
  const { txHash } = await buildSignAndBroadcastNeoN3Tx(
    config,
    script,
    buildCustodySignerAdapter(config, funder),
    { label: 'Neo N3 updater fee top-up' }
  );
  await waitForNeoN3TransactionHalt(config, txHash, 'Neo N3 updater fee top-up');
  return txHash;
}

async function ensureNeoN3FeeBalance(config, target, requiredFee = 0n) {
  const settings = getNeoN3FeeTopUpSettings(config);
  if (!settings.enabled) return { skipped: true, reason: 'disabled' };
  const targetHash = normalizeHash160(target?.scriptHash || target?.address || '');
  if (!targetHash) return { skipped: true, reason: 'invalid-target' };
  const requiredBalance = requiredFee + settings.minBalance;
  const currentBalance = await readNeoN3GasBalance(config, targetHash);
  if (currentBalance >= requiredBalance) {
    return { skipped: true, reason: 'sufficient', balance: currentBalance.toString() };
  }
  const funderKeyId = trimString(config?.neo_n3?.custodyKeyIds?.fee_funder || '');
  if (!funderKeyId) {
    throw new Error(
      'Neo N3 updater fee balance is below reserve; provision a fee-funder custody key (SIGNER_ROLE_FEE_FUNDER_KEY_ID) for auto top-up'
    );
  }
  const funder = await resolveCustodyKeyById(config, funderKeyId);
  const funderHash = normalizeHash160(funder.scriptHash);
  if (funderHash === targetHash) {
    throw new Error('Neo N3 updater fee top-up funder cannot be the same account as the updater');
  }
  const deficit = requiredBalance - currentBalance;
  const amount = deficit > settings.topUpAmount ? deficit : settings.topUpAmount;
  if (settings.maxTopUpAmount > 0n && amount > settings.maxTopUpAmount) {
    throw new Error(
      `Neo N3 updater fee top-up amount ${amount} exceeds configured max ${settings.maxTopUpAmount}`
    );
  }
  const funderBalance = await readNeoN3GasBalance(config, funderHash);
  if (funderBalance < amount + settings.minBalance) {
    throw new Error('Neo N3 updater fee top-up funder has insufficient GAS reserve');
  }
  const txHash = await sendNeoN3GasTransfer(config, funder, targetHash, amount);
  return {
    skipped: false,
    tx_hash: txHash,
    amount: amount.toString(),
    previous_balance: currentBalance.toString(),
    required_balance: requiredBalance.toString(),
  };
}

// Custody key identity lookup (docs/SIGNER_SERVICE.md §5): the relayer names a
// key id and receives the public identity — never the secret. No cache on
// purpose: a rotated key must never keep signing under a stale identity.
async function resolveCustodyKeyById(config, keyId) {
  const key = await custodyKeyInfo(config, keyId);
  const publicKey = normalizePublicKey(key.public_key || '');
  const scriptHash =
    normalizeHash160(key.script_hash || '') ||
    `0x${neonWallet.getScriptHashFromPublicKey(publicKey)}`.toLowerCase();
  return {
    key_id: keyId,
    publicKey,
    scriptHash,
    address: trimString(key.address || ''),
  };
}

async function resolveCustodyUpdater(config) {
  return resolveCustodyKeyById(config, custodyKeyId(config, 'updater'));
}

// The witness's verification script is `0c21 <33B pubkey> 4156e7b327`. §5's
// /sign/transaction reply carries the pinned scripts but no bare public_key
// (only /sign/raw widens it), so recover the key exactly the way the service
// itself does for /sign/raw — sliced out of the verification script.
function publicKeyFromSignedWitness(signed) {
  const verification = trimString(signed.verification_script || '');
  if (/^0c21/i.test(verification) && verification.length >= 70) {
    return normalizePublicKey(verification.slice(4, 70));
  }
  return normalizePublicKey(signed.public_key || '');
}

// Witness strategy for custody-signed transactions: the unsigned serialization
// goes to the enclave, which policy-checks the calls inside and returns the
// complete witness scripts. The recovered public key is re-checked against the
// identity resolved at lookup time so a custody-side key swap cannot pass.
function buildCustodySignerAdapter(config, key) {
  return {
    scriptHash: key.scriptHash,
    sign: async (transaction) => {
      const signed = await custodySignTransaction(config, key.key_id, transaction.serialize(false));
      const publicKey = publicKeyFromSignedWitness(signed);
      if (publicKey.toLowerCase() !== key.publicKey.toLowerCase()) {
        throw new Error('custody signing key changed between lookup and signing');
      }
      transaction.witnesses = [
        new tx.Witness({
          invocationScript: u.HexString.fromHex(signed.invocation_script || ''),
          verificationScript: u.HexString.fromHex(signed.verification_script || ''),
        }),
      ];
    },
    verifyWitness: (transaction) => {
      const witnessHash = normalizeHash160(`0x${transaction.witnesses[0].scriptHash}`);
      if (witnessHash !== key.scriptHash) {
        throw new Error(
          `custody signer witness mismatch: expected ${key.scriptHash}, got ${witnessHash}`
        );
      }
    },
  };
}

function buildFulfillRequestParams(requestId, success, resultHex, error, verificationSignature) {
  return [
    sc.ContractParam.integer(String(requestId)),
    sc.ContractParam.boolean(Boolean(success)),
    sc.ContractParam.byteArray(u.HexString.fromHex(resultHex, true)),
    sc.ContractParam.string(error || ''),
    sc.ContractParam.byteArray(
      u.HexString.fromHex(trimString(verificationSignature || '').replace(/^0x/i, ''), true)
    ),
  ];
}

export function assertNeoN3HaltExecution(requestId, txHash, execution, label = 'fulfillRequest') {
  const vmState = trimString(execution?.vmstate || 'HALT').toUpperCase() || 'HALT';
  const exception = trimString(execution?.exception || '');
  if (vmState !== 'HALT') {
    const detail = exception || `VM state ${vmState}`;
    throw new Error(`Neo N3 ${label} faulted for request ${requestId} (${txHash}): ${detail}`);
  }
  return { vm_state: vmState, exception: exception || undefined };
}

const DEFAULT_FULFILL_CONFIRM_TIMEOUT_MS = 45_000;

function getNeoN3FulfillConfirmTimeoutMs(config) {
  const explicit = Number(config?.neo_n3?.fulfillConfirmTimeoutMs);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const fromFeeTopUp = Number(config?.neo_n3?.feeTopUp?.waitTimeoutMs);
  if (Number.isFinite(fromFeeTopUp) && fromFeeTopUp > 0) return fromFeeTopUp;
  return DEFAULT_FULFILL_CONFIRM_TIMEOUT_MS;
}

// Whether a fulfillRequest whose application log never appears before the
// confirm timeout should be treated as a transient failure (re-broadcast on a
// later tick) instead of a benign terminal UNKNOWN. Defaults to true: a tx that
// was broadcast but never mined (dropped from the mempool) would otherwise be
// recorded as fulfilled, permanently losing the callback, because processEvent
// never inspects vm_state. Re-broadcast is idempotent — a landed-but-unindexed
// tx FAULTs "already fulfilled" on retry and settles. Reversible via
// MORPHEUS_RELAYER_NEO_N3_FULFILL_CONFIRM_THROW_ON_TIMEOUT=false.
function shouldThrowOnNeoN3FulfillConfirmTimeout(config) {
  const value = config?.neo_n3?.fulfillConfirmThrowOnTimeout;
  return value === undefined || value === null ? true : Boolean(value);
}

/**
 * Confirm a broadcast fulfillRequest transaction by polling its application log
 * until the VM result is available. `contract.invoke` and `sendrawtransaction`
 * return immediately after broadcast, so a single getapplicationlog call races
 * the chain: the log may not exist yet (RPC throws / no executions), which would
 * otherwise let a FAULT be recorded as a successful HALT. We poll until a
 * concrete vmstate is observed:
 *   - HALT  -> resolve with vm_state HALT
 *   - FAULT -> throw (never record a faulted tx as fulfilled)
 * If the log never becomes available before the timeout we throw a TRANSIENT
 * error (message contains "timed out" so classifyError routes it to a callback
 * retry / re-broadcast on a later tick) instead of degrading to a benign
 * UNKNOWN. A broadcast-but-never-mined fulfillRequest (dropped from the mempool)
 * would otherwise be recorded as fulfilled and the user request lost forever,
 * because processEvent never inspects vm_state. Re-broadcast is idempotent: a
 * landed-but-unindexed tx FAULTs "already fulfilled" on retry and settles.
 * Operators can restore the prior best-effort behavior with
 * MORPHEUS_RELAYER_NEO_N3_FULFILL_CONFIRM_THROW_ON_TIMEOUT=false.
 */
export async function confirmNeoN3FulfillExecution(
  config,
  requestId,
  txHash,
  label = 'fulfillRequest'
) {
  const deadline = Date.now() + getNeoN3FulfillConfirmTimeoutMs(config);
  let lastError = null;
  for (;;) {
    try {
      const appLog = await neoRpcCall(config, 'getapplicationlog', [txHash]);
      const execution = appLog?.executions?.[0];
      const vmState = trimString(execution?.vmstate || '').toUpperCase();
      if (vmState) {
        // A concrete VM state is present: validate it (throws on FAULT).
        return assertNeoN3HaltExecution(requestId, txHash, execution, label);
      }
      // Log exists but has no execution result yet; keep polling.
    } catch (error) {
      if (error instanceof Error && error.message.includes(`Neo N3 ${label} faulted`)) {
        throw error;
      }
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    if (Date.now() >= deadline) {
      const detail = lastError?.message || `${label} application log unavailable before timeout`;
      if (shouldThrowOnNeoN3FulfillConfirmTimeout(config)) {
        // Transient: re-broadcast on a later tick (idempotent via already-fulfilled).
        throw new Error(
          `Neo N3 ${label} confirmation timed out for request ${requestId} (${txHash}): ${detail}`
        );
      }
      return {
        vm_state: 'UNKNOWN',
        exception: detail,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

export async function fulfillNeoN3Request(
  config,
  requestId,
  success,
  result,
  error,
  verificationSignature,
  resultBytesBase64 = ''
) {
  // No standalone health probe here: buildSignAndBroadcastNeoN3Tx issues its own
  // getblockcount + invokescript RPCs, and neoRpcCall promotes a known-good RPC
  // URL on every successful call (neo-n3.js:114), so a pre-flight probe would be
  // a redundant getblockcount round-trip (up to the 30s RPC timeout) per submit.
  // Fail-fast is preserved: a fully-dead RPC set surfaces at the first submit RPC
  // and retries all configured URLs via neoRpcCall's loop.
  const resultHex = trimString(resultBytesBase64)
    ? base64ToHex(resultBytesBase64)
    : Buffer.from(String(result || ''), 'utf8').toString('hex');
  const updater = await resolveCustodyUpdater(config);
  // Best-effort fee top-up before submission. Fail-soft on purpose: a
  // manually-funded deployment provisions no fee-funder key, and
  // ensureNeoN3FeeBalance throws in that case — which, if it propagated, would
  // block EVERY fulfill. A healthy account (balance >= reserve) skips without a
  // transfer; a genuine underfunding still surfaces at the test invoke or
  // broadcast below.
  try {
    await ensureNeoN3FeeBalance(config, updater);
  } catch {
    // intentionally best-effort — never block an otherwise-fundable fulfill on a top-up problem
  }
  const script = sc.createScript({
    scriptHash: strip0x(config.neo_n3.oracleContract),
    operation: 'fulfillRequest',
    args: buildFulfillRequestParams(requestId, success, resultHex, error, verificationSignature),
  });
  const { txHash } = await buildSignAndBroadcastNeoN3Tx(
    config,
    script,
    buildCustodySignerAdapter(config, updater),
    {
      systemFeeHeadroom: true,
      buildTestInvokeFaultError: (exception) =>
        `Neo N3 fulfillRequest test invoke faulted for request ${requestId}: ${
          exception || 'unknown error'
        }`,
    }
  );
  // Wait for the broadcast to be applied and confirm the VM result. A confirmed
  // FAULT throws here so it is never recorded as a successful fulfillment.
  const outcome = await confirmNeoN3FulfillExecution(config, requestId, txHash);
  return {
    request_id: buildNeoN3RelayRequestId('fulfill', requestId),
    tx_hash: txHash,
    vm_state: outcome.vm_state,
    exception: outcome.exception,
    target_chain: 'neo_n3',
  };
}

// Reads the deployed kernel ABI and reports whether it has the R-01 execution lane
// (queueAutomationExecution/4). Fails closed: an RPC error or a response without an ABI
// throws, so the scheduler retries instead of guessing a lane; the legacy lane on an
// upgraded kernel cannot charge an unsponsored requester and would park the job.
export async function neoN3KernelSupportsAutomationExecution(config) {
  const state = await neoRpcCall(config, 'getcontractstate', [config.neo_n3.oracleContract]);
  return kernelManifestSupportsAutomationExecution(state?.manifest);
}

// Pure: the kernel entry point and arguments for one automation execution. On a kernel
// with the execution lane and a job that carries its registration id, the execution is
// tied to the job's on-chain registration and names the job owner the kernel must find
// there; otherwise the legacy lane names the requester and the callback contract.
export function buildNeoN3AutomationQueueInvocation({
  supportsExecutionLane,
  registrationRequestId,
  requester,
  requestType,
  payloadText,
  callbackContract,
  callbackMethod,
}) {
  const payloadBase64 = Buffer.from(payloadText || '', 'utf8').toString('base64');
  const lane = selectAutomationQueueLane({ supportsExecutionLane, registrationRequestId });
  if (lane.method === AUTOMATION_EXECUTION_QUEUE_METHOD) {
    return {
      operation: lane.method,
      args: [
        sc.ContractParam.integer(lane.registrationRequestId),
        sc.ContractParam.hash160(requester),
        sc.ContractParam.string(requestType),
        sc.ContractParam.byteArray(payloadBase64),
      ],
    };
  }
  return {
    operation: lane.method,
    args: [
      sc.ContractParam.hash160(requester),
      sc.ContractParam.string(requestType),
      sc.ContractParam.byteArray(payloadBase64),
      sc.ContractParam.hash160(callbackContract),
      sc.ContractParam.string(callbackMethod),
    ],
  };
}

export async function queueNeoN3AutomationRequest(
  config,
  requester,
  requestType,
  payloadText,
  callbackContract,
  callbackMethod,
  requestIdOverride = '',
  registrationRequestId = ''
) {
  const requestId = trimString(requestIdOverride) || `automation:n3:${Date.now()}`;
  // Only a job that carries its registration id can use the execution lane, so only then
  // is the deployed ABI read.
  const supportsExecutionLane = normalizeAutomationRegistrationRequestId(registrationRequestId)
    ? await neoN3KernelSupportsAutomationExecution(config)
    : false;
  const invocation = buildNeoN3AutomationQueueInvocation({
    supportsExecutionLane,
    registrationRequestId,
    requester,
    requestType,
    payloadText,
    callbackContract,
    callbackMethod,
  });
  const updater = await resolveCustodyUpdater(config);
  // Best-effort fee top-up before submission, mirroring fulfillNeoN3Request.
  // Fail-soft for the same reason: a manually-funded deployment provisions no
  // fee-funder key, and a genuine underfunding still surfaces at the test
  // invoke or broadcast below.
  try {
    await ensureNeoN3FeeBalance(config, updater);
  } catch {
    // intentionally best-effort — never block an otherwise-fundable queue on a top-up problem
  }
  const script = sc.createScript({
    scriptHash: strip0x(config.neo_n3.oracleContract),
    operation: invocation.operation,
    args: invocation.args,
  });
  try {
    const { txHash } = await buildSignAndBroadcastNeoN3Tx(
      config,
      script,
      buildCustodySignerAdapter(config, updater),
      {
        systemFeeHeadroom: true,
        buildTestInvokeFaultError: (exception) =>
          `Neo N3 automation queue test invoke faulted for ${requester}: ${
            exception || 'unknown error'
          }`,
      }
    );
    // The queue is only durable once the invoke lands on-chain: wait for the app
    // log and fail-closed on a non-HALT execution (the kernel never received the
    // request otherwise, so the scheduler must retry instead of trusting a tick).
    const outcome = await confirmNeoN3FulfillExecution(
      config,
      requestId,
      txHash,
      'automation queue'
    );
    return {
      tx_hash: txHash,
      request_id: requestId,
      vm_state: outcome.vm_state,
      target_chain: 'neo_n3',
      signer_source: 'custody_updater',
      queue_method: invocation.operation,
    };
  } catch (error) {
    if (/request_id already used/i.test(String(error?.message || ''))) {
      return { duplicate: true, request_id: requestId, target_chain: 'neo_n3' };
    }
    throw error;
  }
}

export async function fetchNeoN3FeedRecord(config, pair) {
  const result = await neoRpcCall(config, 'invokefunction', [
    config.neo_n3.datafeedContract,
    'getLatest',
    [{ type: 'String', value: pair }],
  ]);
  if (String(result?.state || '').toUpperCase() === 'FAULT') {
    throw new Error(result?.exception || `Neo N3 getLatest faulted for ${pair}`);
  }
  const decoded = decodeNeoItem(result?.stack?.[0], 'base64');
  if (!Array.isArray(decoded) || decoded.length < 6) {
    throw new Error(`Neo N3 feed response malformed for ${pair}`);
  }
  return {
    pair: String(decoded[0] || pair),
    roundId: String(decoded[1] || '0'),
    price: String(decoded[2] || '0'),
    timestamp: String(decoded[3] || '0'),
    attestationHash: String(decoded[4] || ''),
    sourceSetId: String(decoded[5] || '0'),
  };
}
