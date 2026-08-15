export const CANONICAL_FEED_PROVIDER_PREFIX = 'TWELVEDATA:';
export const KNOWN_FEED_PROVIDER_PREFIXES = [
  'TWELVEDATA:',
  'BINANCE-SPOT:',
  'COINBASE-SPOT:',
] as const;

const DEFAULT_FEED_BASE_SYMBOLS = [
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
  'COPPER-USD',
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
    meaning: 'WTI crude oil reference price in USD',
    sourceSymbol: 'WTI/USD',
    unit: 'WTI reference unit',
  },
  'BRENT-USD': {
    pair: 'BRENT-USD',
    label: 'Brent Crude Oil',
    category: 'Commodity',
    meaning: 'Brent crude spot reference price in USD',
    sourceSymbol: 'XBR/USD',
    unit: 'Brent spot reference unit',
  },
  'NATGAS-USD': {
    pair: 'NATGAS-USD',
    label: 'Natural Gas',
    category: 'Commodity',
    meaning: 'Natural gas reference price in USD',
    sourceSymbol: 'NG/USD',
    unit: 'Natural gas reference unit',
  },
  'COPPER-USD': {
    pair: 'COPPER-USD',
    label: 'Copper Futures',
    category: 'Commodity',
    meaning: 'Copper front-month futures proxy in USD',
    sourceSymbol: 'HG1',
    unit: '1 copper futures reference unit',
    note: 'Uses TwelveData copper futures symbol HG1.',
  },
  'WHEAT-USD': {
    pair: 'WHEAT-USD',
    label: 'Wheat Futures',
    category: 'Commodity',
    meaning: 'Wheat front-month futures proxy in USD',
    sourceSymbol: 'W_1',
    unit: '1 wheat futures reference unit',
    note: 'Uses TwelveData agricultural futures symbol W_1.',
  },
  'CORN-USD': {
    pair: 'CORN-USD',
    label: 'Corn Futures',
    category: 'Commodity',
    meaning: 'Corn front-month futures proxy in USD',
    sourceSymbol: 'C_1',
    unit: '1 corn futures reference unit',
    note: 'Uses TwelveData agricultural futures symbol C_1.',
  },
  'SOY-USD': {
    pair: 'SOY-USD',
    label: 'Soybean Futures',
    category: 'Commodity',
    meaning: 'Soybean front-month futures proxy in USD',
    sourceSymbol: 'S_1',
    unit: '1 soybean futures reference unit',
    note: 'Uses TwelveData agricultural futures symbol S_1.',
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
    sourceSymbol: 'USD/JPY',
    unit: '1 JPY',
    note: 'Fetched as USD/JPY, then inverted.',
  },
  'CNY-USD': {
    pair: 'CNY-USD',
    label: 'Chinese Yuan',
    category: 'FX',
    meaning: 'Price of 1 CNY in USD',
    sourceSymbol: 'USD/CNY',
    unit: '1 CNY',
    note: 'Fetched as USD/CNY, then inverted.',
  },
};

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
