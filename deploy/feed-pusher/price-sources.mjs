// Multi-source price quotes for the NeoOS DataFeed pusher.
//
// TwelveData's free tier is 800 credits/day and bills one credit per symbol, so
// a 32-pair, 5-minute pusher burned the quota in ~25 minutes every day. These
// sources are exchange/market public endpoints with no per-symbol billing, and
// every symbol is cross-checked so a single bad print cannot reach the chain.

const MAX_SPREAD_BPS = 100;
const TIMEOUT_MS = 12_000;

const BINANCE_VISION = 'https://data-api.binance.vision/api/v3/ticker/price';
const OKX = 'https://www.okx.com/api/v5/market/ticker';
const GATE = 'https://api.gateio.ws/api/v4/spot/tickers';
const COINGECKO = 'https://api.coingecko.com/api/v3/simple/price';
const KRAKEN = 'https://api.kraken.com/0/public/Ticker';
const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart';
const TWELVEDATA = 'https://api.twelvedata.com/price';

const BINANCE_SYMBOLS = {
  'NEO-USD': 'NEOUSDT', 'BTC-USD': 'BTCUSDT', 'ETH-USD': 'ETHUSDT',
  'BNB-USD': 'BNBUSDT', 'XRP-USD': 'XRPUSDT', 'SOL-USD': 'SOLUSDT',
  'TRX-USD': 'TRXUSDT', 'DOGE-USD': 'DOGEUSDT', 'PAXG-USD': 'PAXGUSDT',
};

const OKX_SYMBOLS = {
  'NEO-USD': 'NEO-USDT', 'GAS-USD': 'GAS-USDT', 'BTC-USD': 'BTC-USDT',
  'ETH-USD': 'ETH-USDT', 'BNB-USD': 'BNB-USDT', 'XRP-USD': 'XRP-USDT',
  'SOL-USD': 'SOL-USDT', 'TRX-USD': 'TRX-USDT', 'DOGE-USD': 'DOGE-USDT',
  'PAXG-USD': 'PAXG-USDT',
};

const GATE_SYMBOLS = {
  'NEO-USD': 'NEO_USDT', 'GAS-USD': 'GAS_USDT', 'BTC-USD': 'BTC_USDT',
  'ETH-USD': 'ETH_USDT', 'SOL-USD': 'SOL_USDT', 'DOGE-USD': 'DOGE_USDT',
};

const KRAKEN_SYMBOLS = {
  'USDT-USD': 'USDTUSD', 'USDC-USD': 'USDCUSD', 'BTC-USD': 'XBTUSD',
  'ETH-USD': 'ETHUSD', 'XRP-USD': 'XRPUSD',
};

const COINGECKO_IDS = {
  'NEO-USD': 'neo', 'GAS-USD': 'gas', 'BTC-USD': 'bitcoin',
  'ETH-USD': 'ethereum', 'USDT-USD': 'tether', 'USDC-USD': 'usd-coin',
  'BNB-USD': 'binancecoin', 'XRP-USD': 'ripple', 'SOL-USD': 'solana',
  'TRX-USD': 'tron', 'DOGE-USD': 'dogecoin', 'PAXG-USD': 'pax-gold',
};

const YAHOO_SYMBOLS = {
  'AAPL-USD': 'AAPL', 'GOOGL-USD': 'GOOGL', 'MSFT-USD': 'MSFT',
  'AMZN-USD': 'AMZN', 'TSLA-USD': 'TSLA', 'META-USD': 'META',
  'NVDA-USD': 'NVDA', 'SPY-USD': 'SPY', 'QQQ-USD': 'QQQ', 'GLD-USD': 'GLD',
  'EUR-USD': 'EURUSD=X', 'GBP-USD': 'GBPUSD=X', 'JPY-USD': 'JPYUSD=X',
  'CNY-USD': 'CNYUSD=X',
};

const TWELVEDATA_SYMBOLS = {
  'WTI-USD': 'USO',
  'BRENT-USD': 'BNO',
  'NATGAS-USD': 'UNG',
  'WHEAT-USD': 'WEAT',
  'CORN-USD': 'CORN',
  'SOY-USD': 'SOYB',
};

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function fromBinance(pairs, fetchImpl) {
  const out = {};
  const wanted = pairs.filter((p) => BINANCE_SYMBOLS[p]);
  await Promise.all(wanted.map(async (pair) => {
    try {
      const j = await getJson(BINANCE_VISION + '?symbol=' + BINANCE_SYMBOLS[pair], fetchImpl);
      const price = positive(j && j.price);
      if (price) out[pair] = price;
    } catch {}
  }));
  return out;
}

async function fromOkx(pairs, fetchImpl) {
  try {
    const out = {};
    const wanted = pairs.filter((p) => OKX_SYMBOLS[p]);
    if (!wanted.length) return out;
    const instType = wanted.every(p => p.includes('USD')) ? 'SPOT' : 'SWAP';
    const j = await getJson(OKX + '?instType=' + instType, fetchImpl);
    const data = j && j.data ? j.data : [];
    for (const pair of wanted) {
      const symbol = OKX_SYMBOLS[pair];
      const row = data.find(r => r.instId === symbol);
      const price = positive(row && row.last);
      if (price) out[pair] = price;
    }
    return out;
  } catch {
    return {};
  }
}

async function fromGate(pairs, fetchImpl) {
  const out = {};
  const wanted = pairs.filter((p) => GATE_SYMBOLS[p]);
  await Promise.all(wanted.map(async (pair) => {
    try {
      const rows = await getJson(GATE + '?currency_pair=' + GATE_SYMBOLS[pair], fetchImpl);
      const row = Array.isArray(rows) ? rows[0] : null;
      const price = positive(row && row.last);
      if (price) out[pair] = price;
    } catch {}
  }));
  return out;
}

async function fromCoinGecko(pairs, fetchImpl) {
  const wanted = pairs.filter((p) => COINGECKO_IDS[p]);
  if (!wanted.length) return {};
  const ids = [...new Set(wanted.map((p) => COINGECKO_IDS[p]))].join(',');
  const j = await getJson(COINGECKO + '?ids=' + ids + '&vs_currencies=usd', fetchImpl);
  const out = {};
  for (const pair of wanted) {
    const price = positive(j && j[COINGECKO_IDS[pair]] && j[COINGECKO_IDS[pair]].usd);
    if (price) out[pair] = price;
  }
  return out;
}

async function fromKraken(pairs, fetchImpl) {
  const out = {};
  const wanted = pairs.filter((p) => KRAKEN_SYMBOLS[p]);
  await Promise.all(wanted.map(async (pair) => {
    try {
      const j = await getJson(KRAKEN + '?pair=' + KRAKEN_SYMBOLS[pair], fetchImpl);
      const rows = j && j.result ? Object.values(j.result) : [];
      const price = positive(rows[0] && rows[0].c && rows[0].c[0]);
      if (price) out[pair] = price;
    } catch {}
  }));
  return out;
}

async function fromYahoo(pairs, fetchImpl) {
  const out = {};
  const wanted = pairs.filter((p) => YAHOO_SYMBOLS[p]);
  for (const pair of wanted) {
    try {
      const symbol = YAHOO_SYMBOLS[pair];
      const j = await getJson(YAHOO_CHART + '/' + symbol + '?interval=1d&range=1d', fetchImpl);
      const indicators = j?.chart?.result?.[0]?.indicators;
      const quote = indicators?.quote?.[0];
      const close = quote?.close;
      if (Array.isArray(close)) {
        for (let i = close.length - 1; i >= 0; i--) {
          const price = positive(close[i]);
          if (price) { out[pair] = price; break; }
        }
      }
    } catch {}
    if (wanted.indexOf(pair) < wanted.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  return out;
}

async function fromTwelveData(pairs, fetchImpl, apiKey) {
  try {
    const out = {};
    const wanted = pairs.filter((p) => TWELVEDATA_SYMBOLS[p]);
    if (!wanted.length || !apiKey) return out;
    await Promise.all(wanted.map(async (pair) => {
      try {
        const symbol = TWELVEDATA_SYMBOLS[pair];
        const j = await getJson(TWELVEDATA + '?symbol=' + symbol + '&apikey=' + apiKey, fetchImpl);
        const price = positive(j && j.price);
        if (price) out[pair] = price;
      } catch {}
    }));
    return out;
  } catch {
    return {};
  }
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function consensus(quotes) {
  if (!quotes.length) return { ok: false, reason: 'no_quote' };
  const values = quotes.map((q) => q.price);
  const price = median(values);
  if (quotes.length === 1) return { ok: true, price, sources: [quotes[0].source], consensus: 'single' };
  const spreadBps = ((Math.max(...values) - Math.min(...values)) / price) * 10000;
  if (spreadBps > MAX_SPREAD_BPS) return { ok: false, reason: 'spread_' + Math.round(spreadBps) + 'bps' };
  return { ok: true, price, sources: quotes.map((q) => q.source), consensus: 'cross_checked' };
}

export async function collectPrices(pairs, { fetchImpl = globalThis.fetch, log = console.log } = {}) {
  const [binance, okx, gate, coingecko, kraken, yahoo] = await Promise.all([
    fromBinance(pairs, fetchImpl),
    fromOkx(pairs, fetchImpl),
    fromGate(pairs, fetchImpl),
    fromCoinGecko(pairs, fetchImpl),
    fromKraken(pairs, fetchImpl),
    fromYahoo(pairs, fetchImpl),
  ]);
  const tdKey = typeof process !== 'undefined' && process.env?.TD_KEY;
  const twelveData = await fromTwelveData(pairs, fetchImpl, tdKey);
  const prices = {};
  const detail = {};
  const rejected = {};
  for (const pair of pairs) {
    const quotes = [];
    if (binance[pair]) quotes.push({ source: 'binance', price: binance[pair] });
    if (okx[pair]) quotes.push({ source: 'okx', price: okx[pair] });
    if (gate[pair]) quotes.push({ source: 'gate', price: gate[pair] });
    if (coingecko[pair]) quotes.push({ source: 'coingecko', price: coingecko[pair] });
    if (kraken[pair]) quotes.push({ source: 'kraken', price: kraken[pair] });
    if (yahoo[pair]) quotes.push({ source: 'yahoo', price: yahoo[pair] });
    if (twelveData[pair]) quotes.push({ source: 'twelvedata', price: twelveData[pair] });
    if (quotes.length === 0) { rejected[pair] = 'no_source'; continue; }
    const result = consensus(quotes);
    if (!result.ok) { rejected[pair] = result.reason; continue; }
    prices[pair] = result.price;
    detail[pair] = { sources: result.sources, consensus: result.consensus };
  }
  return { prices, detail, rejected };
}
