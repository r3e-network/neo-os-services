import { trimString } from '../../platform/core.js';
import { FEED_PRICE_DECIMALS } from './shared.js';
import { integerToDecimalString } from './decimal.js';

function isPrintableAscii(value) {
  return /^[\x09\x0a\x0d\x20-\x7e]*$/.test(value);
}

function decodeNeoByteString(bytes) {
  const text = bytes.toString('utf8');
  const reversedText = Buffer.from(bytes).reverse().toString('utf8');
  const knownPairPrefixes = ['TWELVEDATA:', 'BINANCE-SPOT:', 'COINBASE-SPOT:'];
  if (
    isPrintableAscii(reversedText) &&
    knownPairPrefixes.some((prefix) => reversedText.startsWith(prefix))
  ) {
    return reversedText;
  }
  if (isPrintableAscii(text)) return text;
  if (isPrintableAscii(reversedText) && /^[A-Z0-9:_-]+$/.test(reversedText)) {
    return reversedText;
  }
  return `0x${bytes.toString('hex')}`;
}

function parseNeoStackItem(item) {
  if (!item || typeof item !== 'object') return null;
  const type = trimString(item.type).toLowerCase();
  switch (type) {
    case 'array':
    case 'struct':
      return Array.isArray(item.value) ? item.value.map((entry) => parseNeoStackItem(entry)) : [];
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

export async function fetchJsonRpc(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
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

async function fetchNeoN3FeedRecords(rpcUrl, contractHash) {
  if (!trimString(rpcUrl) || !trimString(contractHash)) return {};
  const result = await fetchJsonRpc(rpcUrl, {
    jsonrpc: '2.0',
    id: 1,
    method: 'invokefunction',
    params: [contractHash, 'getAllFeedRecords', []],
  });
  if (String(result?.state || '').toUpperCase() === 'FAULT') {
    throw new Error(trimString(result?.exception) || 'getAllFeedRecords faulted');
  }
  const rawRecords = parseNeoStackItem(result?.stack?.[0]);
  if (!Array.isArray(rawRecords)) return {};
  return Object.fromEntries(
    rawRecords
      .filter((entry) => Array.isArray(entry) && entry.length >= 6)
      .map((entry) => {
        const storagePair = trimString(entry[0]);
        const priceUnits = String(entry[2] ?? '0');
        return [
          storagePair,
          {
            storage_pair: storagePair,
            pair: storagePair.includes(':')
              ? storagePair.split(':').slice(1).join(':')
              : storagePair,
            round_id: String(entry[1] ?? '0'),
            price_units: priceUnits,
            price: integerToDecimalString(priceUnits, FEED_PRICE_DECIMALS),
            timestamp: String(entry[3] ?? '0'),
            attestation_hash: trimString(entry[4]),
            source_set_id: String(entry[5] ?? '0'),
            price_scale_decimals: FEED_PRICE_DECIMALS,
          },
        ];
      })
  );
}

export async function loadOnchainFeedRecords(
  targetChain,
  { neoContext = null, dataFeedHash = null } = {}
) {
  try {
    if (targetChain === 'neo_n3') {
      return {
        records: await fetchNeoN3FeedRecords(neoContext?.rpcUrl, dataFeedHash),
        error: null,
      };
    }
  } catch (error) {
    return {
      records: {},
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return { records: {}, error: null };
}
