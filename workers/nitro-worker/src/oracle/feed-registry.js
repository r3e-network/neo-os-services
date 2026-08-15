import { env, trimString } from '../platform/core.js';
import { normalizeProviderId } from './providers.js';

const FEED_PAIR_ALIASES = {
  'OIL-USD': 'WTI-USD',
};
const KNOWN_FEED_PROVIDER_PREFIXES = ['TWELVEDATA:', 'BINANCE-SPOT:', 'COINBASE-SPOT:'];

export const DEFAULT_FEED_PAIRS = {
  'NEO-USD': {
    providers: {
      twelvedata: { symbol: 'NEO/USD' },
      'binance-spot': { symbol: 'NEOUSDT' },
    },
  },
  'GAS-USD': {
    providers: {
      twelvedata: { symbol: 'GAS/USD' },
      'binance-spot': { symbol: 'GASUSDT' },
    },
  },
  'BTC-USD': {
    providers: {
      twelvedata: { symbol: 'BTC-USD' },
    },
  },
  'ETH-USD': {
    providers: {
      twelvedata: { symbol: 'ETH-USD' },
    },
  },
  'SOL-USD': {
    providers: {
      twelvedata: { symbol: 'SOL-USD' },
    },
  },
  'TRX-USD': {
    providers: {
      twelvedata: { symbol: 'TRX-USD' },
    },
  },
  'PAXG-USD': {
    providers: {
      twelvedata: { symbol: 'PAXG-USD' },
    },
  },
  'WTI-USD': {
    providers: {
      twelvedata: { symbol: 'WTI-USD' },
    },
  },
  'BRENT-USD': {
    providers: {
      twelvedata: { symbol: 'XBR/USD' },
    },
  },
  'NATGAS-USD': {
    providers: {
      twelvedata: { symbol: 'NG/USD' },
    },
  },
  'COPPER-USD': {
    providers: {
      twelvedata: { symbol: 'HG1' },
    },
  },
  'WHEAT-USD': {
    providers: {
      twelvedata: { symbol: 'W_1' },
    },
  },
  'CORN-USD': {
    providers: {
      twelvedata: { symbol: 'C_1' },
    },
  },
  'SOY-USD': {
    providers: {
      twelvedata: { symbol: 'S_1' },
    },
  },
  'USDT-USD': {
    providers: {
      twelvedata: { symbol: 'USDT-USD' },
    },
  },
  'USDC-USD': {
    providers: {
      twelvedata: { symbol: 'USDC-USD' },
    },
  },
  'BNB-USD': {
    providers: {
      twelvedata: { symbol: 'BNB-USD' },
    },
  },
  'XRP-USD': {
    providers: {
      twelvedata: { symbol: 'XRP-USD' },
    },
  },
  'DOGE-USD': {
    providers: {
      twelvedata: { symbol: 'DOGE-USD' },
    },
  },
  'AAPL-USD': {
    providers: {
      twelvedata: { symbol: 'AAPL' },
    },
  },
  'GOOGL-USD': {
    providers: {
      twelvedata: { symbol: 'GOOGL' },
    },
  },
  'MSFT-USD': {
    providers: {
      twelvedata: { symbol: 'MSFT' },
    },
  },
  'AMZN-USD': {
    providers: {
      twelvedata: { symbol: 'AMZN' },
    },
  },
  'TSLA-USD': {
    providers: {
      twelvedata: { symbol: 'TSLA' },
    },
  },
  'META-USD': {
    providers: {
      twelvedata: { symbol: 'META' },
    },
  },
  'NVDA-USD': {
    providers: {
      twelvedata: { symbol: 'NVDA' },
    },
  },
  'SPY-USD': {
    providers: {
      twelvedata: { symbol: 'SPY' },
    },
  },
  'QQQ-USD': {
    providers: {
      twelvedata: { symbol: 'QQQ' },
    },
  },
  'GLD-USD': {
    providers: {
      twelvedata: { symbol: 'GLD' },
    },
  },
  'EUR-USD': {
    providers: {
      twelvedata: { symbol: 'EUR/USD' },
    },
  },
  'GBP-USD': {
    providers: {
      twelvedata: { symbol: 'GBP/USD' },
    },
  },
  'JPY-USD': {
    price_transform: 'inverse',
    providers: {
      twelvedata: { symbol: 'USD/JPY' },
    },
  },
  'CNY-USD': {
    price_transform: 'inverse',
    providers: {
      twelvedata: { symbol: 'USD/CNY' },
    },
  },
};

const DEFAULT_SOURCE_SET_IDS = {
  twelvedata: 1,
  'binance-spot': 2,
  'coinbase-spot': 3,
};

function deepMerge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return base;
  const output = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      output[key] &&
      typeof output[key] === 'object' &&
      !Array.isArray(output[key])
    ) {
      output[key] = deepMerge(output[key], value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function parseRegistryOverride(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function normalizeFeedPairSymbol(pair) {
  const normalized = trimString(pair).toUpperCase();
  const stripped = KNOWN_FEED_PROVIDER_PREFIXES.find((prefix) => normalized.startsWith(prefix))
    ? normalized.slice(normalized.indexOf(':') + 1)
    : normalized;
  return FEED_PAIR_ALIASES[stripped] || stripped;
}

// Memoize the merged registry keyed on the raw MORPHEUS_FEED_PAIR_REGISTRY_JSON
// override string. The merged result depends only on that string (DEFAULT_FEED_PAIRS
// is static), so caching avoids re-running deepMerge + JSON.parse on every getter
// call (a single feed run fans out to hundreds of these). Keying on the raw string
// keeps the cache correct when the override changes at runtime (e.g. env-mutating
// tests): a different override value is a different key and re-derives the merge.
let cachedRegistryKey;
let cachedRegistry;

export function getFeedPairRegistry() {
  const raw = trimString(env('MORPHEUS_FEED_PAIR_REGISTRY_JSON'));
  if (raw !== cachedRegistryKey || cachedRegistry === undefined) {
    cachedRegistry = deepMerge(DEFAULT_FEED_PAIRS, parseRegistryOverride(raw));
    cachedRegistryKey = raw;
  }
  return cachedRegistry;
}

export function __resetFeedRegistryCacheForTests() {
  cachedRegistryKey = undefined;
  cachedRegistry = undefined;
}

export function getFeedPairConfig(pair) {
  const registry = getFeedPairRegistry();
  return registry[normalizeFeedPairSymbol(pair)] || null;
}

export function getFeedDisplaySymbol(pair) {
  return (
    trimString(getFeedPairConfig(pair)?.display_symbol || '') ||
    getFeedStoragePair('twelvedata', pair)
  );
}

export function getFeedUnitLabel(pair) {
  return trimString(getFeedPairConfig(pair)?.unit_label || '');
}

export function getFeedPriceMultiplier(pair) {
  const raw = Number(getFeedPairConfig(pair)?.price_multiplier ?? 1);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

export function getFeedPriceTransform(pair) {
  return trimString(getFeedPairConfig(pair)?.price_transform || '').toLowerCase();
}

export function getFeedProvidersForPair(pair) {
  const config = getFeedPairConfig(pair);
  if (!config?.providers || typeof config.providers !== 'object') return [];
  return Object.keys(config.providers)
    .map((provider) => normalizeProviderId(provider))
    .filter(Boolean);
}

export function getDefaultFeedSymbols() {
  return Object.keys(getFeedPairRegistry()).map((pair) => getFeedStoragePair('twelvedata', pair));
}

export function applyFeedProviderDefaults(pair, providerId, payload = {}) {
  const normalizedPair = normalizeFeedPairSymbol(pair);
  const config = getFeedPairConfig(pair);
  const provider = normalizeProviderId(providerId);
  const providerDefaults =
    config?.providers?.[provider] && typeof config.providers[provider] === 'object'
      ? config.providers[provider]
      : {};
  return {
    ...payload,
    symbol: trimString(payload.symbol || normalizedPair).toUpperCase(),
    provider,
    provider_params: {
      ...(providerDefaults || {}),
      ...(payload.provider_params && typeof payload.provider_params === 'object'
        ? payload.provider_params
        : {}),
    },
  };
}

export function getFeedStoragePair(providerId, pair) {
  return `${normalizeProviderId(providerId).toUpperCase()}:${normalizeFeedPairSymbol(pair)}`;
}

export function getSourceSetIdForProvider(providerId, fallback = 0) {
  return DEFAULT_SOURCE_SET_IDS[normalizeProviderId(providerId)] ?? fallback;
}
