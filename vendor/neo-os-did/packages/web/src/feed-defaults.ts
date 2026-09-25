export const CANONICAL_FEED_PROVIDER_PREFIX = 'TWELVEDATA:';
export const KNOWN_FEED_PROVIDER_PREFIXES = [
  'TWELVEDATA:',
  'BINANCE-SPOT:',
  'COINBASE-SPOT:',
] as const;

/**
 * The advertised feed set. This list, the pusher's `TD_SYMBOLS` table in
 * `deploy/feed-pusher/feed-pusher.mjs` and the worker registry in
 * `workers/nitro-worker/src/oracle/feed-registry.js` must name the same pairs and
 * the same provider symbols; `scripts/check-feed-pair-registries.mjs` fails the
 * build when they drift apart.
 *
 * Advertising a pair nobody can source is what made `/api/feeds/status` read
 * "degraded" permanently — the same defect class that let a 22-day outage look
 * healthy. A pair that cannot be sourced correctly belongs in RETIRED_FEED_PAIRS,
 * not here.
 */
export const DEFAULT_FEED_BASE_SYMBOLS = [
  'NEO-USD',
  'GAS-USD',
  'BTC-USD',
  'ETH-USD',
  'SOL-USD',
  'TRX-USD',
  'PAXG-USD',
  'WTI-USD',
  'BRENT-USD',
  'NATGAS-USD',
  'WHEAT-USD',
  'CORN-USD',
  'SOY-USD',
  'USDT-USD',
  'USDC-USD',
  'BNB-USD',
  'XRP-USD',
  'DOGE-USD',
  'AAPL-USD',
  'GOOGL-USD',
  'MSFT-USD',
  'AMZN-USD',
  'TSLA-USD',
  'META-USD',
  'NVDA-USD',
  'SPY-USD',
  'QQQ-USD',
  'GLD-USD',
  'EUR-USD',
  'GBP-USD',
  'JPY-USD',
  'CNY-USD',
] as const;

export const DEFAULT_FEED_SYMBOLS = DEFAULT_FEED_BASE_SYMBOLS.map(
  (symbol) => `${CANONICAL_FEED_PROVIDER_PREFIX}${symbol}`
);

export type FeedDescriptor = {
  pair: string;
  label: string;
  category: 'Crypto' | 'Commodity' | 'Equity' | 'ETF' | 'FX';
  meaning: string;
  sourceSymbol: string;
  unit: string;
  note?: string;
};

const BARE_FEED_DESCRIPTORS: Record<string, FeedDescriptor> = {
  'NEO-USD': {
    pair: 'NEO-USD',
    label: 'Neo Token',
    category: 'Crypto',
    meaning: 'Price of 1 NEO in USD',
    sourceSymbol: 'NEO/USD',
    unit: '1 NEO',
  },
  'GAS-USD': {
    pair: 'GAS-USD',
    label: 'Neo GAS Token',
    category: 'Crypto',
    meaning: 'Price of 1 GAS in USD',
    sourceSymbol: 'GAS/USD',
    unit: '1 GAS',
  },
  'BTC-USD': {
    pair: 'BTC-USD',
    label: 'Bitcoin',
    category: 'Crypto',
    meaning: 'Price of 1 BTC in USD',
    sourceSymbol: 'BTC/USD',
    unit: '1 BTC',
  },
  'ETH-USD': {
    pair: 'ETH-USD',
    label: 'Ethereum',
    category: 'Crypto',
    meaning: 'Price of 1 ETH in USD',
    sourceSymbol: 'ETH/USD',
    unit: '1 ETH',
  },
  'SOL-USD': {
    pair: 'SOL-USD',
    label: 'Solana Token',
    category: 'Crypto',
    meaning: 'Price of 1 SOL in USD',
    sourceSymbol: 'SOL/USD',
    unit: '1 SOL',
  },
  'TRX-USD': {
    pair: 'TRX-USD',
    label: 'TRON Token',
    category: 'Crypto',
    meaning: 'Price of 1 TRX in USD',
    sourceSymbol: 'TRX/USD',
    unit: '1 TRX',
  },
  'PAXG-USD': {
    pair: 'PAXG-USD',
    label: 'PAX Gold',
    category: 'Crypto',
    meaning: 'Price of 1 PAXG token in USD',
    sourceSymbol: 'PAXG/USD',
    unit: '1 PAXG',
  },
  'WTI-USD': {
    pair: 'WTI-USD',
    label: 'WTI Crude Oil',
    category: 'Commodity',
    meaning: 'WTI crude oil spot reference price, USD per barrel',
    sourceSymbol: 'WTI/USD',
    unit: '1 barrel',
  },
  'BRENT-USD': {
    pair: 'BRENT-USD',
    label: 'Brent Crude Oil',
    category: 'Commodity',
    meaning: 'Brent crude spot reference price, USD per barrel',
    sourceSymbol: 'XBR/USD',
    unit: '1 barrel',
  },
  'NATGAS-USD': {
    pair: 'NATGAS-USD',
    label: 'Natural Gas',
    category: 'Commodity',
    meaning: 'Natural gas reference price, USD per MMBtu',
    sourceSymbol: 'NG/USD',
    unit: '1 MMBtu',
  },
  'WHEAT-USD': {
    pair: 'WHEAT-USD',
    label: 'Wheat Futures',
    category: 'Commodity',
    meaning: 'CBOT wheat front-month futures, US cents per bushel',
    sourceSymbol: 'W_1',
    unit: '1 bushel (US cents)',
    note: 'TwelveData agricultural futures symbol W_1. Quoted in US cents per bushel, not dollars.',
  },
  'CORN-USD': {
    pair: 'CORN-USD',
    label: 'Corn Futures',
    category: 'Commodity',
    meaning: 'CBOT corn front-month futures, US cents per bushel',
    sourceSymbol: 'C_1',
    unit: '1 bushel (US cents)',
    note: 'TwelveData agricultural futures symbol C_1. NOT the bare ticker CORN, which is the Teucrium Corn Fund ETF.',
  },
  'SOY-USD': {
    pair: 'SOY-USD',
    label: 'Soybean Futures',
    category: 'Commodity',
    meaning: 'CBOT soybean front-month futures, US cents per bushel',
    sourceSymbol: 'S_1',
    unit: '1 bushel (US cents)',
    note: 'TwelveData agricultural futures symbol S_1. Quoted in US cents per bushel, not dollars.',
  },
  'USDT-USD': {
    pair: 'USDT-USD',
    label: 'Tether USD',
    category: 'Crypto',
    meaning: 'Price of 1 USDT in USD',
    sourceSymbol: 'USDT/USD',
    unit: '1 USDT',
  },
  'USDC-USD': {
    pair: 'USDC-USD',
    label: 'USD Coin',
    category: 'Crypto',
    meaning: 'Price of 1 USDC in USD',
    sourceSymbol: 'USDC/USD',
    unit: '1 USDC',
  },
  'BNB-USD': {
    pair: 'BNB-USD',
    label: 'Binance Coin',
    category: 'Crypto',
    meaning: 'Price of 1 BNB in USD',
    sourceSymbol: 'BNB/USD',
    unit: '1 BNB',
  },
  'XRP-USD': {
    pair: 'XRP-USD',
    label: 'XRP Token',
    category: 'Crypto',
    meaning: 'Price of 1 XRP in USD',
    sourceSymbol: 'XRP/USD',
    unit: '1 XRP',
  },
  'DOGE-USD': {
    pair: 'DOGE-USD',
    label: 'Dogecoin',
    category: 'Crypto',
    meaning: 'Price of 1 DOGE in USD',
    sourceSymbol: 'DOGE/USD',
    unit: '1 DOGE',
  },
  'AAPL-USD': {
    pair: 'AAPL-USD',
    label: 'Apple Inc.',
    category: 'Equity',
    meaning: 'Price of 1 AAPL share in USD',
    sourceSymbol: 'AAPL',
    unit: '1 share',
  },
  'GOOGL-USD': {
    pair: 'GOOGL-USD',
    label: 'Alphabet Class A',
    category: 'Equity',
    meaning: 'Price of 1 GOOGL share in USD',
    sourceSymbol: 'GOOGL',
    unit: '1 share',
  },
  'MSFT-USD': {
    pair: 'MSFT-USD',
    label: 'Microsoft',
    category: 'Equity',
    meaning: 'Price of 1 MSFT share in USD',
    sourceSymbol: 'MSFT',
    unit: '1 share',
  },
  'AMZN-USD': {
    pair: 'AMZN-USD',
    label: 'Amazon',
    category: 'Equity',
    meaning: 'Price of 1 AMZN share in USD',
    sourceSymbol: 'AMZN',
    unit: '1 share',
  },
  'TSLA-USD': {
    pair: 'TSLA-USD',
    label: 'Tesla',
    category: 'Equity',
    meaning: 'Price of 1 TSLA share in USD',
    sourceSymbol: 'TSLA',
    unit: '1 share',
  },
  'META-USD': {
    pair: 'META-USD',
    label: 'Meta Platforms',
    category: 'Equity',
    meaning: 'Price of 1 META share in USD',
    sourceSymbol: 'META',
    unit: '1 share',
  },
  'NVDA-USD': {
    pair: 'NVDA-USD',
    label: 'NVIDIA',
    category: 'Equity',
    meaning: 'Price of 1 NVDA share in USD',
    sourceSymbol: 'NVDA',
    unit: '1 share',
  },
  'SPY-USD': {
    pair: 'SPY-USD',
    label: 'SPDR S&P 500 ETF',
    category: 'ETF',
    meaning: 'Price of 1 SPY share in USD',
    sourceSymbol: 'SPY',
    unit: '1 ETF share',
  },
  'QQQ-USD': {
    pair: 'QQQ-USD',
    label: 'Invesco QQQ ETF',
    category: 'ETF',
    meaning: 'Price of 1 QQQ share in USD',
    sourceSymbol: 'QQQ',
    unit: '1 ETF share',
  },
  'GLD-USD': {
    pair: 'GLD-USD',
    label: 'SPDR Gold Shares',
    category: 'ETF',
    meaning: 'Price of 1 GLD share in USD',
    sourceSymbol: 'GLD',
    unit: '1 ETF share',
  },
  'EUR-USD': {
    pair: 'EUR-USD',
    label: 'Euro',
    category: 'FX',
    meaning: 'Price of 1 EUR in USD',
    sourceSymbol: 'EUR/USD',
    unit: '1 EUR',
  },
  'GBP-USD': {
    pair: 'GBP-USD',
    label: 'British Pound',
    category: 'FX',
    meaning: 'Price of 1 GBP in USD',
    sourceSymbol: 'GBP/USD',
    unit: '1 GBP',
  },
  'JPY-USD': {
    pair: 'JPY-USD',
    label: 'Japanese Yen',
    category: 'FX',
    meaning: 'Price of 1 JPY in USD',
    sourceSymbol: 'JPY/USD',
    unit: '1 JPY',
    note: 'Fetched directly as JPY/USD; nothing in the on-chain write path inverts it.',
  },
  'CNY-USD': {
    pair: 'CNY-USD',
    label: 'Chinese Yuan',
    category: 'FX',
    meaning: 'Price of 1 CNY in USD',
    sourceSymbol: 'CNY/USD',
    unit: '1 CNY',
    note: 'Fetched directly as CNY/USD; nothing in the on-chain write path inverts it.',
  },
};

export type RetiredFeedPair = {
  pair: string;
  /** Why the configured provider cannot serve this pair correctly. */
  reason: string;
  /** ISO date the pair was retired. */
  retired_on: string;
  /** What would have to be true to reinstate it, or '' when it is gone for good. */
  reinstate_requires: string;
};

/**
 * Pairs deliberately NOT advertised and NOT pushed, with the evidence.
 *
 * A pair that cannot be sourced correctly used to be left in the advertised list,
 * where it produced a permanent `status: "degraded"` that no operator could clear —
 * so nobody looked at the signal, and a 22-day feed outage hid inside it. Retiring
 * is the honest alternative: the pair leaves every active registry, the health
 * count, and the on-chain writer, and the reason stays visible here.
 *
 * This list is mirrored by RETIRED_FEED_PAIRS in
 * `deploy/feed-pusher/feed-pusher.mjs`; `scripts/check-feed-pair-registries.mjs`
 * fails if a retired pair reappears in any active registry, or if the two lists
 * disagree.
 */
export const RETIRED_FEED_PAIRS: Record<string, RetiredFeedPair> = {
  'COPPER-USD': {
    pair: 'COPPER-USD',
    reason:
      'TwelveData\'s /commodities reference lists HG1 as "Copper Spot", but /price and /quote resolve HG1 to Homag Group AG — a Frankfurt-listed woodworking-machinery stock quoting 24.40 EUR. The on-chain COPPER-USD record (24.40, last written 2026-06-06) is that equity price, not copper.',
    retired_on: '2026-08-20',
    reinstate_requires:
      'a per-symbol fetch using exchange=Forex (which cannot ride the batched comma-separated /price call), plus an admin feed reset for the pair — re-anchoring 24.40 to the real 6.46 USD/lb is a -73.5% move the deviation guard correctly refuses.',
  },
  'FLM-USD': {
    pair: 'FLM-USD',
    reason:
      'TwelveData\'s /cryptocurrencies reference gives FLM/USD currency_base "FolmCoin". It is not Flamingo Finance, which is what FLM means to a Neo consumer of this feed. Cross-checked 2026-08-20: TwelveData FLM/USD = 0.0025054 vs CoinGecko flamingo-finance = 0.00053932 (4.6x apart), with CoinGecko neo = 1.87 vs on-chain NEO-USD = 1.864 confirming the comparison. TwelveData has no Flamingo Finance listing.',
    retired_on: '2026-08-20',
    reinstate_requires:
      'a provider that actually lists Flamingo Finance (e.g. a Neo DEX or CEX source added to the provider set).',
  },
  '1000FLM-USD': {
    pair: '1000FLM-USD',
    reason:
      'Legacy scaled variant left on chain from an earlier feed generation; last written 2026-03-11 and in no configuration since. Unsourceable for the same reason as FLM-USD.',
    retired_on: '2026-08-20',
    reinstate_requires: '',
  },
  '1000JPY-USD': {
    pair: '1000JPY-USD',
    reason:
      'Legacy scaled variant left on chain from an earlier feed generation; last written 2026-03-11 and in no configuration since. Superseded by JPY-USD.',
    retired_on: '2026-08-20',
    reinstate_requires: '',
  },
};

export const RETIRED_FEED_SYMBOLS = Object.keys(RETIRED_FEED_PAIRS).map(
  (pair) => `${CANONICAL_FEED_PROVIDER_PREFIX}${pair}`
);

export function getRetiredFeedPair(symbol: string) {
  return RETIRED_FEED_PAIRS[stripFeedProviderPrefix(symbol)] || null;
}

export function stripFeedProviderPrefix(symbol: string) {
  const normalized = String(symbol || '')
    .trim()
    .toUpperCase();
  const prefix = KNOWN_FEED_PROVIDER_PREFIXES.find((entry) => normalized.startsWith(entry));
  return prefix ? normalized.slice(prefix.length) : normalized;
}

export function toCanonicalFeedSymbol(symbol: string) {
  const normalized = stripFeedProviderPrefix(symbol);
  if (!normalized) return `${CANONICAL_FEED_PROVIDER_PREFIX}NEO-USD`;
  return `${CANONICAL_FEED_PROVIDER_PREFIX}${normalized}`;
}

export const FEED_DESCRIPTORS: Record<string, FeedDescriptor> = Object.fromEntries(
  Object.entries(BARE_FEED_DESCRIPTORS).map(([pair, descriptor]) => {
    const canonicalPair = toCanonicalFeedSymbol(pair);
    return [canonicalPair, { ...descriptor, pair: canonicalPair }];
  })
);

export function normalizeFeedSymbol(symbol: string) {
  return toCanonicalFeedSymbol(
    String(symbol || '')
      .trim()
      .toUpperCase()
  );
}

export function getFeedDisplaySymbol(symbol: string) {
  return normalizeFeedSymbol(symbol);
}

export function getFeedDescriptor(symbol: string) {
  return FEED_DESCRIPTORS[normalizeFeedSymbol(symbol)] || null;
}

export function getAllFeedDescriptors() {
  return DEFAULT_FEED_SYMBOLS.map((symbol) => FEED_DESCRIPTORS[symbol]).filter(Boolean);
}

export function parseFeedSymbols(rawValue?: string | null) {
  const raw = String(rawValue || '').trim();
  if (!raw) return [...DEFAULT_FEED_SYMBOLS];
  return raw
    .split(',')
    .map((symbol) => normalizeFeedSymbol(symbol))
    .filter(Boolean);
}

export function parseFeedProviders(rawValue?: string | null) {
  const raw = String(rawValue || '').trim();
  if (!raw) return ['twelvedata'];
  return raw
    .split(',')
    .map((provider) => provider.trim().toLowerCase())
    .filter(Boolean);
}
