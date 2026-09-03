import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import pkg from '@cityofzion/neon-js';
const { sc, wallet, tx, u } = pkg;

// ── Shared config ────────────────────────────────────────────────────────────
const TD_KEY = process.env.TD_KEY;
const THRESHOLD_BPS = Number(process.env.THRESHOLD_BPS || 10);
const MAX_STALE_SEC = Number(process.env.MAX_STALE_SEC || 1800);
// Price-sanity guard: reject a candidate price that deviates from the existing
// on-chain price by more than MAX_DEVIATION_BPS (default 5000 = 50%). A zero or
// absurd source quote (TwelveData glitch, half-populated batch) would otherwise
// be signed straight onto the feed every chain consumes. Set the admin-override
// env to 0 to bypass for a genuine flash move (e.g. a real >50% candle).
const MAX_DEVIATION_BPS = Number(process.env.MAX_DEVIATION_BPS || 5000);
const LOG = process.env.PUSH_LOG || '/opt/morpheus/nitro/feed-pusher.log';
const SYMBOLS = (process.env.SYMBOLS || 'NEO-USD,GAS-USD,BTC-USD,ETH-USD').split(',');
// Consecutive-cycle missing-symbol alerting: each oneshot cycle persists the
// per-symbol miss counters here so a symbol TwelveData stopped serving raises
// an explicit ALERT line (picked up by log monitoring) instead of silently
// counting as "missing N" forever.
const MISSING_STATE = process.env.MISSING_STATE || '/opt/morpheus/nitro/feed-pusher-missing.json';
const MISSING_ALERT_CYCLES = Number(process.env.MISSING_ALERT_CYCLES || 3);
const log = (m) => {
  const line = `[${new Date().toISOString()}] ${m}`;
  try {
    appendFileSync(LOG, line + '\n');
  } catch {}
  console.log(line);
};

// ── Push decision core (shared by both chains, exported for tests) ───────────
// Single writer invariant: a signed batch must never regress the on-chain round
// OR timestamp. The N3 contract asserts timestamp monotonicity itself, but the
// deployed MorpheusPriceFeed.sol on Neo X only checks roundId, so the pusher is
// the sole enforcement point for timestamps there.
export function planFeedUpdate(
  cur,
  newPrice,
  now,
  {
    thresholdBps = THRESHOLD_BPS,
    maxStaleSec = MAX_STALE_SEC,
    maxDeviationBps = MAX_DEVIATION_BPS,
  } = {}
) {
  // Price-sanity guard (centralized here so it covers BOTH the N3 and EVM push
  // paths). A non-finite or non-positive candidate price is always rejected —
  // signing it would poison the feed and burn the updater's gas on a bad write.
  if (!Number.isFinite(newPrice) || newPrice <= 0) {
    return { push: false, round: cur.round, ts: cur.ts, rejected: 'invalid_price' };
  }
  // Deviation spike guard: when a valid on-chain price already exists, reject a
  // candidate that jumps more than maxDeviationBps from it. The bootstrap case
  // (cur.price<=0, no usable reference) is exempt so the very first write — or a
  // recovery after AdminResetFeed — still lands. maxDeviationBps<=0 is the admin
  // override env for a genuine flash move.
  if (cur.price > 0 && maxDeviationBps > 0) {
    const deviationBps = (Math.abs(newPrice - cur.price) / cur.price) * 10000;
    if (deviationBps > maxDeviationBps) {
      return { push: false, round: cur.round, ts: cur.ts, rejected: 'deviation_spike' };
    }
  }
  const recent = cur.round > 0 && now - cur.round < maxStaleSec;
  const unchanged =
    cur.price > 0 && (Math.abs(newPrice - cur.price) / cur.price) * 10000 < thresholdBps;
  if (recent && unchanged) return { push: false, round: cur.round, ts: cur.ts };
  return { push: true, round: Math.max(cur.round + 1, now), ts: Math.max(cur.ts, now) };
}

// FeedRecord = [Pair, RoundId, Price, Timestamp, AttestationHash, SourceSetId]
export function parseGetLatestStack(result) {
  const v =
    result && result.state === 'HALT'
      ? result.stack && result.stack[0] && result.stack[0].value
      : null;
  return Array.isArray(v)
    ? {
        round: Number(v[1].value || 0),
        price: Number(v[2].value || 0) / 1e6,
        ts: Number(v[3].value || 0),
      }
    : { round: 0, price: 0, ts: 0 };
}

// Batched read: getAllFeedRecords returns every registered FeedRecord in one
// invoke. Returns a Map keyed by the on-chain pair string (e.g.
// 'TWELVEDATA:NEO-USD') → { round, price, ts }, or null when the invoke did not
// HALT (caller falls back to per-pair getLatest). A pair absent from the map is
// simply not registered yet — same zeroed default getLatest would return.
export function parseGetAllFeedRecordsStack(result) {
  if (!result || result.state !== 'HALT') return null;
  const records =
    result.stack && result.stack[0] && Array.isArray(result.stack[0].value)
      ? result.stack[0].value
      : [];
  const byPair = new Map();
  for (const record of records) {
    const v = record && record.value;
    if (!Array.isArray(v) || v.length < 4) continue;
    const pair = Buffer.from(String(v[0].value || ''), 'base64').toString('utf8');
    if (!pair) continue;
    byPair.set(pair, {
      round: Number(v[1].value || 0),
      price: Number(v[2].value || 0) / 1e6,
      ts: Number(v[3].value || 0),
    });
  }
  return byPair;
}

// Consecutive-cycle missing-symbol tracking (pure, exported for tests): symbols
// present in `prices` reset their counter; requested-but-missing symbols
// increment it, and once a counter reaches `alertAfter` the symbol is reported
// every cycle until it recovers (or is pruned from SYMBOLS).
export function trackMissingSymbols(
  prevCounts,
  requested,
  prices,
  alertAfter = MISSING_ALERT_CYCLES
) {
  const counts = { ...(prevCounts && typeof prevCounts === 'object' ? prevCounts : {}) };
  const alerts = [];
  for (const symbol of requested) {
    if (symbol in prices) {
      delete counts[symbol];
      continue;
    }
    counts[symbol] = (Number(counts[symbol]) || 0) + 1;
    if (counts[symbol] >= alertAfter) alerts.push({ symbol, cycles: counts[symbol] });
  }
  return { counts, alerts };
}

function readMissingState() {
  try {
    const parsed = JSON.parse(readFileSync(MISSING_STATE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeMissingState(counts) {
  try {
    writeFileSync(MISSING_STATE, JSON.stringify(counts));
  } catch {}
}

// TwelveData provider symbols are an EXPLICIT per-pair table, never a guess.
//
// Two production faults came from deriving the provider symbol from the pair name:
//   1. A blanket dash→slash rewrite produced 'AAPL/USD', which TwelveData 404s.
//      That silently took the whole equity/ETF lane stale from ~2026-06.
//   2. The fix for (1) added a bare-ticker set that included 'CORN', so CORN-USD
//      started resolving to CORN = *Teucrium Corn Fund*, an NYSE ETF quoting ~$18.9,
//      while the on-chain CORN-USD series is CBOT corn futures (C_1, ~479 ¢/bushel).
//      Every cycle after that was correctly rejected by the deviation guard and the
//      pair sat permanently stale — a "degraded" health signal nobody could clear.
// Guessing a provider symbol is how an oracle publishes the wrong asset under the
// right name. The table below is the ONLY mapping, and an unmapped entry in SYMBOLS
// is refused loudly rather than guessed at (see the UNMAPPED alert in the cycle).
//
// Every mapping was verified against api.twelvedata.com/quote on 2026-08-20; the
// instrument name TwelveData resolved is recorded so a future silent re-resolution
// (the exact failure mode above) shows up as a diff instead of a wrong price.
export const TD_SYMBOLS = new Map([
  // Crypto — TwelveData 'Synthetic'/exchange-backed X/USD pairs.
  ['NEO-USD', 'NEO/USD'], // NEO US Dollar (Binance)
  ['GAS-USD', 'GAS/USD'], // Gas US Dollar (OKEx)
  ['BTC-USD', 'BTC/USD'], // Bitcoin US Dollar (Binance)
  ['ETH-USD', 'ETH/USD'], // Ethereum US Dollar (Binance)
  ['SOL-USD', 'SOL/USD'], // Solana US Dollar (Binance)
  ['TRX-USD', 'TRX/USD'], // TRON US Dollar (Binance)
  ['PAXG-USD', 'PAXG/USD'], // PAX Gold US Dollar (Binance)
  ['USDT-USD', 'USDT/USD'], // Tether US Dollar (Kraken)
  ['USDC-USD', 'USDC/USD'], // USD Coin US Dollar (Binance)
  ['BNB-USD', 'BNB/USD'], // Binance Coin US Dollar (Binance)
  ['XRP-USD', 'XRP/USD'], // XRP US Dollar (Binance)
  ['DOGE-USD', 'DOGE/USD'], // Dogecoin US Dollar (Binance)
  // FX — quoted DIRECTLY as base/USD, so no inversion happens anywhere in this
  // path. JPY/USD and CNY/USD both resolve on TwelveData and match the values
  // already on chain; do not "fix" these to USD/JPY + invert.
  ['EUR-USD', 'EUR/USD'], // Euro / US Dollar (Forex)
  ['GBP-USD', 'GBP/USD'], // British Pound / US Dollar (Forex)
  ['JPY-USD', 'JPY/USD'], // Japanese Yen / US Dollar (Forex)
  ['CNY-USD', 'CNY/USD'], // Chinese Yuan / US Dollar (Forex)
  // Commodities — TwelveData lists these under its 'Forex'/commodities lane.
  // The `X_1` forms are front-month futures and quote in the exchange's native
  // unit (US cents per bushel for the grains), NOT in dollars per unit.
  ['WTI-USD', 'WTI/USD'], // Crude Oil WTI Spot / US Dollar
  ['BRENT-USD', 'XBR/USD'], // Brent Spot / US Dollar
  ['NATGAS-USD', 'NG/USD'], // Natural Gas / US Dollar
  ['WHEAT-USD', 'W_1'], // Wheat Futures (¢/bushel)
  ['CORN-USD', 'C_1'], // Corn Futures (¢/bushel)  — NOT 'CORN' (Teucrium ETF)
  ['SOY-USD', 'S_1'], // Soybeans Futures (¢/bushel)
  // Equities / ETFs — bare ticker; 'AAPL/USD' 404s.
  ['AAPL-USD', 'AAPL'], // Apple Inc. (NASDAQ)
  ['GOOGL-USD', 'GOOGL'], // Alphabet Inc. Class A (NASDAQ)
  ['MSFT-USD', 'MSFT'], // Microsoft Corporation (NASDAQ)
  ['AMZN-USD', 'AMZN'], // Amazon.com Inc. (NASDAQ)
  ['TSLA-USD', 'TSLA'], // Tesla, Inc. (NASDAQ)
  ['META-USD', 'META'], // Meta Platforms, Inc. Class A (NASDAQ)
  ['NVDA-USD', 'NVDA'], // NVIDIA Corporation (NASDAQ)
  ['SPY-USD', 'SPY'], // SPDR S&P 500 ETF Trust (NYSE ARCA)
  ['QQQ-USD', 'QQQ'], // Invesco QQQ Trust, Series 1 (NASDAQ)
  ['GLD-USD', 'GLD'], // SPDR Gold Shares (NYSE ARCA)
]);

// Pairs deliberately NOT pushed, with the reason. Retiring a pair here is the
// honest alternative to leaving it advertised and permanently stale: a pair the
// configured provider cannot serve correctly must not appear in SYMBOLS, in the
// advertised feed list, or in a health count.
//
// These are asserted by scripts/check-feed-pair-registries.mjs: a retired pair
// that reappears in any active registry fails the check.
export const RETIRED_FEED_PAIRS = new Map([
  [
    'COPPER-USD',
    // TwelveData's /commodities reference lists HG1 as "Copper Spot", but
    // /price?symbol=HG1 and /quote?symbol=HG1 resolve HG1 to *Homag Group AG*,
    // a Frankfurt-listed woodworking-machinery stock quoting 24.40 EUR. The
    // on-chain COPPER-USD record (24.40, last written 2026-06-06) is that equity
    // price, not copper. Real copper needs /quote?symbol=HG1&exchange=Forex
    // (6.46 USD/lb), which cannot ride the batched comma-separated /price call
    // this pusher uses, and re-anchoring 24.40 → 6.46 is a -73.5% move that the
    // deviation guard correctly refuses. Reinstating it needs BOTH an admin feed
    // reset for the pair AND a per-symbol disambiguated fetch. Retired until then.
    'twelvedata HG1 resolves to Homag Group AG (FSX, EUR), not copper; correct copper needs exchange=Forex plus an on-chain reset',
  ],
  [
    'FLM-USD',
    // TwelveData's /cryptocurrencies reference is explicit: FLM/USD has
    // currency_base "FolmCoin". It is NOT Flamingo Finance, which is what FLM
    // means to every Neo consumer of this feed. Cross-check on 2026-08-20:
    // TwelveData FLM/USD = 0.0025054 while CoinGecko flamingo-finance = 0.00053932
    // (4.6x apart) with CoinGecko neo = 1.87 vs on-chain NEO-USD = 1.864 confirming
    // the comparison method. TwelveData has no Flamingo Finance listing at all.
    // Publishing FolmCoin under the FLM ticker is a wrong-asset defect, so the
    // pair is retired rather than advertised.
    'twelvedata FLM/USD is FolmCoin, not Flamingo Finance; no Flamingo listing exists on this provider',
  ],
  [
    '1000FLM-USD',
    'legacy scaled variant, last written 2026-03-11, superseded and unsourceable (see FLM-USD)',
  ],
  ['1000JPY-USD', 'legacy scaled variant, last written 2026-03-11, superseded by JPY-USD'],
]);

export function toTwelveDataSymbol(symbol) {
  return TD_SYMBOLS.get(String(symbol).trim().toUpperCase()) || null;
}

/**
 * Split a requested symbol list into the ones this pusher can map and the ones it
 * cannot. Pure + exported so the unmapped-symbol behaviour is unit-testable.
 * An unmapped symbol is NEVER guessed at: it is reported and dropped.
 */
export function partitionMappedSymbols(symbols) {
  const mapped = [];
  const unmapped = [];
  for (const symbol of symbols) {
    (toTwelveDataSymbol(symbol) ? mapped : unmapped).push(symbol);
  }
  return { mapped, unmapped };
}

function sanitizeProviderErrorMessage(value) {
  return String(value || 'upstream request failed')
    .replace(/([?&]apikey=)[^&\s]+/gi, '$1<redacted>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

// TwelveData returns provider failures as JSON, including for non-2xx responses.
// Treating that top-level object as a successful one-symbol payload made every
// configured pair look "missing" and hid billing/rate-limit outages behind exit 0.
export function assertTwelveDataResponse(response, body) {
  const providerCode = Number(body && body.code);
  const providerFailed =
    body &&
    typeof body === 'object' &&
    (String(body.status || '').toLowerCase() === 'error' ||
      (Number.isFinite(providerCode) && providerCode >= 400));
  if (response.ok && !providerFailed) return;

  const code = Number.isFinite(providerCode) ? `, code ${providerCode}` : '';
  const message = sanitizeProviderErrorMessage(body && body.message);
  throw new Error(`TwelveData upstream error (HTTP ${response.status}${code}): ${message}`);
}

/**
 * Pairs the HOST planned to write that the ENCLAVE did not include in its signed
 * batch, restricted to pairs whose existing on-chain record is already past the
 * force-refresh window.
 *
 * When MORPHEUS_FEED_PUSHER_ENCLAVE_SIGN=true the enclave fetches its own prices and
 * plans inside the measured boundary, so the authoritative provider-symbol mapping is
 * the copy baked into the running EIF — NOT the file on this host. A host that has
 * been fixed while the enclave still carries an older mapping therefore looks
 * completely healthy: the cycle succeeds, the log says "pushed N pairs", and the
 * affected pairs simply never move. That is exactly how CORN-USD and the BRENT /
 * NATGAS / WHEAT / SOY commodity lane sat 75 days stale while every cycle reported
 * success.
 *
 * A pair the enclave declines for an ordinary reason (its own fetch put the price back
 * inside the change threshold between the two fetches) is NOT reported: only pairs
 * that are already stale enough to be due a forced heartbeat and STILL were not
 * written, which no benign disagreement explains.
 */
export function enclaveDroppedStalePairs(plannedPairs, enclavePairs, onchainState, now, staleSec) {
  const written = new Set((enclavePairs || []).map((pair) => String(pair)));
  const dropped = [];
  for (const pair of plannedPairs || []) {
    if (written.has(pair)) continue;
    const symbol = String(pair).replace(/^TWELVEDATA:/, '');
    const record = onchainState[symbol];
    if (!record) continue;
    const age = now - Number(record.timestamp || 0);
    if (Number.isFinite(age) && age > staleSec) dropped.push({ symbol, age_seconds: age });
  }
  return dropped;
}

async function td(syms) {
  const { mapped, unmapped } = partitionMappedSymbols(syms);
  for (const symbol of unmapped) {
    log(
      `⚠️ ALERT: ${symbol} has no TwelveData mapping — add it to TD_SYMBOLS (with the resolved instrument verified) or drop it from SYMBOLS. Refusing to guess a provider symbol.`
    );
  }
  if (!mapped.length) return {};
  const t = mapped.map((s) => toTwelveDataSymbol(s));
  const r = await fetch(
    `https://api.twelvedata.com/price?symbol=${encodeURIComponent(t.join(','))}&apikey=${TD_KEY}`,
    { signal: AbortSignal.timeout(25000) }
  );
  const text = await r.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error('TwelveData non-JSON (HTTP ' + r.status + ')');
  }
  assertTwelveDataResponse(r, j);
  const o = {};
  for (const s of mapped) {
    const k = toTwelveDataSymbol(s);
    const e = t.length === 1 ? j : j[k];
    const v = e && e.price;
    const n = Number(v);
    // Drop non-positive / non-finite source quotes here so a zero or negative
    // TwelveData reading is treated as "missing" rather than a 0-priced push.
    if (v != null && Number.isFinite(n) && n > 0) o[s] = n;
  }
  return o;
}

// ── Neo N3 (NeoVM) chain: MorpheusDataFeed, signed by the 8787 enclave updater ─
const N3_RPCS = (
  process.env.FEED_RPCS ||
  'https://mainnet1.neo.coz.io:443,https://api.n3index.dev/mainnet,https://rpc10.n3.nspcc.ru:10331'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const N3_MAGIC = Number(process.env.FEED_MAGIC || 860833102);
const N3_FEED = '03013f49c42a14546c8bbe58f9d434c3517fccab';
const GASH = 'd2a4cff31913016155e38e474a2c06d08be276cf';
const N3_UPDATER_PUB = '02f63e3f618d8f6995eb85279a03361beb715d25d3b97407c73c351d26ba849744';
const N3_UPDATER_SH = '9fb28bdacfaa7fcc0a4d660d0dc990b0e7d46118';
const SIGNER = process.env.SIGNER_URL || 'http://127.0.0.1:8787';
const TOKEN = process.env.RUNTIME_TOKEN;
const N3_GAS_WARN = Number(process.env.GAS_WARN || 8);
// N3 feed updates are always computed and semantically constructed inside the
// enclave. The former flag-off path sent arbitrary getMessageForSigning bytes to
// /sign/payload, turning the updater key into a blind-signing oracle.

async function defaultN3Rpc(method, params) {
  let lastErr;
  for (const url of N3_RPCS) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(15000),
      });
      const text = await r.text();
      let j;
      try {
        j = JSON.parse(text);
      } catch {
        throw new Error('non-JSON from ' + url.replace(/^https?:\/\//, '').split('/')[0]);
      }
      if (j.error) throw new Error(method + ': ' + JSON.stringify(j.error).slice(0, 120));
      return j.result;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// Injectable RPC seam so the flag-on pushNeoN3 cycle is unit-testable end-to-end
// without live Neo RPC nodes (the test supplies deterministic responses). The
// systemd entrypoint never touches the setter, so production behavior is unchanged.
let n3rpcImpl = defaultN3Rpc;
function n3rpc(method, params) {
  return n3rpcImpl(method, params);
}
export function __setN3RpcForTests(fn) {
  n3rpcImpl = typeof fn === 'function' ? fn : defaultN3Rpc;
}
export function __resetN3RpcForTests() {
  n3rpcImpl = defaultN3Rpc;
}
async function n3cur(pair) {
  const j = await n3rpc('invokefunction', [
    `0x${N3_FEED}`,
    'getLatest',
    [{ type: 'String', value: 'TWELVEDATA:' + pair }],
  ]);
  return parseGetLatestStack(j);
}
// Compute-in-enclave feed sign: the enclave fetches prices, plans,
// scales, builds the updateFeeds tx from the supplied tx_params (block count +
// fees + an explicit nonce so the result is reproducible) and signs its message
// IN the measured boundary. Returns the authoritative plan + tx_nonce +
// valid_until_block + signature so this host can rebuild the IDENTICAL tx and
// attach the witness. Injectable so the flag-on path is unit-testable without a
// live enclave (the test replaces it with a deterministic enclave response).
let enclaveFeedSignImpl = defaultEnclaveFeedSign;

async function defaultEnclaveFeedSign(requestBody) {
  const r = await fetch(`${SIGNER}/feed/sign`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error('enclave /feed/sign non-JSON (HTTP ' + r.status + ')');
  }
  if (!r.ok)
    throw new Error('enclave /feed/sign failed (HTTP ' + r.status + '): ' + (j.error || ''));
  return j;
}

// Test seam: override / restore the enclave /feed/sign caller.
export function __setEnclaveFeedSignForTests(fn) {
  enclaveFeedSignImpl = typeof fn === 'function' ? fn : defaultEnclaveFeedSign;
}
export function __resetEnclaveFeedSignForTests() {
  enclaveFeedSignImpl = defaultEnclaveFeedSign;
}

// Rebuild the EXACT updateFeeds tx the enclave signed, from the enclave's
// authoritative plan arrays + the pinned tx_nonce + the tx fee params, and return
// {txn, message}. The construction mirrors pushNeoN3's tx build field-for-field so
// the host's getMessageForSigning(N3_MAGIC) reproduces the enclave's
// tx_message_hex. Exported for the flag-on unit test.
export function rebuildUpdateFeedsTxFromEnclavePlan(plan, txParams) {
  const { pairs, rounds, prices_scaled: PX, timestamps: TS, attestation_hashes: AH } = plan;
  const SS = Array.isArray(plan.source_set_ids) ? plan.source_set_ids : pairs.map(() => 0);
  const script = sc.createScript({
    scriptHash: N3_FEED,
    operation: 'updateFeeds',
    args: [
      sc.ContractParam.array(...pairs.map((x) => sc.ContractParam.string(x))),
      sc.ContractParam.array(...rounds.map((x) => sc.ContractParam.integer(x))),
      sc.ContractParam.array(...PX.map((x) => sc.ContractParam.integer(x))),
      sc.ContractParam.array(...TS.map((x) => sc.ContractParam.integer(x))),
      sc.ContractParam.array(...AH.map((x) => sc.ContractParam.byteArray(x))),
      sc.ContractParam.array(...SS.map((x) => sc.ContractParam.integer(x))),
    ],
  });
  const txn = new tx.Transaction({
    nonce: txParams.nonce,
    signers: [{ account: N3_UPDATER_SH, scopes: tx.WitnessScope.CalledByEntry }],
    validUntilBlock: txParams.validUntilBlock,
    script,
  });
  txn.systemFee = u.BigInteger.fromNumber(txParams.systemFee);
  txn.networkFee = u.BigInteger.fromNumber(txParams.networkFee);
  return { txn, script, message: txn.getMessageForSigning(N3_MAGIC) };
}
async function n3UpdaterGas() {
  try {
    const j = await n3rpc('invokefunction', [
      `0x${GASH}`,
      'balanceOf',
      [{ type: 'Hash160', value: '0x' + N3_UPDATER_SH }],
    ]);
    return Number((j.stack && j.stack[0] && j.stack[0].value) || 0) / 1e8;
  } catch {
    return -1;
  }
}

export async function pushNeoN3(prices, now) {
  const P = [],
    R = [],
    PX = [],
    TS = [],
    AH = [],
    SS = [];
  let skipped = 0,
    missing = 0;
  // On-chain state the enclave /feed/sign path needs to plan independently (the
  // host fetches it once and forwards it so the enclave does not duplicate the RPC
  // reads). Keyed by bare symbol (e.g. NEO-USD) -> {round, price, timestamp}.
  const onchainState = {};
  // Batched current-state read: one getAllFeedRecords invoke per cycle instead
  // of one getLatest per symbol. Falls back to the per-pair reads when the
  // batched invoke fails (e.g. an RPC that rejects the larger response).
  let recordMap = null;
  try {
    recordMap = parseGetAllFeedRecordsStack(
      await n3rpc('invokefunction', [`0x${N3_FEED}`, 'getAllFeedRecords', []])
    );
  } catch (e) {
    log('[neo-n3] getAllFeedRecords failed (falling back to per-pair reads): ' + e.message);
  }
  for (const s of SYMBOLS) {
    if (!(s in prices)) {
      missing++;
      continue;
    }
    const c = recordMap
      ? recordMap.get('TWELVEDATA:' + s) || { round: 0, price: 0, ts: 0 }
      : await n3cur(s);
    onchainState[s] = { round: c.round, price: c.price, timestamp: c.ts };
    const px = Math.round(prices[s] * 1e6);
    const plan = planFeedUpdate(c, prices[s], now);
    if (!plan.push) {
      if (plan.rejected)
        log(
          `[neo-n3] ⚠️ rejected ${s} ${plan.rejected}: src=${prices[s]} on-chain=${c.price} (set MAX_DEVIATION_BPS=0 to override a real flash move)`
        );
      skipped++;
      continue;
    }
    const round = plan.round,
      ts = plan.ts;
    AH.push(createHash('sha256').update(`${s}|${px}|${ts}`).digest('hex').slice(0, 32));
    P.push('TWELVEDATA:' + s);
    R.push(round);
    PX.push(px);
    TS.push(ts);
    SS.push(0);
  }
  if (!P.length) {
    log(`[neo-n3] no updates (skipped ${skipped}, missing ${missing})`);
  } else {
    const script = sc.createScript({
      scriptHash: N3_FEED,
      operation: 'updateFeeds',
      args: [
        sc.ContractParam.array(...P.map((x) => sc.ContractParam.string(x))),
        sc.ContractParam.array(...R.map((x) => sc.ContractParam.integer(x))),
        sc.ContractParam.array(...PX.map((x) => sc.ContractParam.integer(x))),
        sc.ContractParam.array(...TS.map((x) => sc.ContractParam.integer(x))),
        sc.ContractParam.array(...AH.map((x) => sc.ContractParam.byteArray(x))),
        sc.ContractParam.array(...SS.map((x) => sc.ContractParam.integer(x))),
      ],
    });
    const count = await n3rpc('getblockcount', []);
    const txn = new tx.Transaction({
      signers: [{ account: N3_UPDATER_SH, scopes: tx.WitnessScope.CalledByEntry }],
      validUntilBlock: count + 500,
      script,
    });
    const inv = await n3rpc('invokescript', [
      u.HexString.fromHex(script).toBase64(),
      [{ account: '0x' + N3_UPDATER_SH, scopes: 'CalledByEntry' }],
    ]);
    if (inv.state !== 'HALT') {
      log('[neo-n3] invokescript FAULT (skip cycle): ' + inv.exception);
      return;
    }
    txn.systemFee = u.BigInteger.fromNumber(inv.gasconsumed);
    const verif = wallet.getVerificationScriptFromPublicKey(N3_UPDATER_PUB);
    txn.witnesses = [
      new tx.Witness({ invocationScript: '0c40' + '00'.repeat(64), verificationScript: verif }),
    ];
    const nf = await n3rpc('calculatenetworkfee', [
      u.HexString.fromHex(txn.serialize(true)).toBase64(),
    ]);
    txn.networkFee = u.BigInteger.fromNumber(nf.networkfee);
    txn.witnesses = [];

    {
      // The enclave computes the value+decision and signs the tx message
      // inside the measured boundary. The host pins the tx nonce + fees (the
      // reproducibility key — see enclave-server buildUpdateFeedsTxMessage) and
      // forwards the on-chain state it already read so the enclave plans against
      // the same baseline. The enclave returns the authoritative plan + the
      // signed message; the host rebuilds the IDENTICAL tx from that plan + the
      // pinned nonce/fees and ASSERTS its getMessageForSigning equals the returned
      // tx_message_hex before attaching the witness (fails closed on any drift).
      const txNonce = txn.nonce;
      const txParams = {
        nonce: txNonce,
        validUntilBlock: count + 500,
        systemFee: Number(txn.systemFee.toString()),
        networkFee: Number(txn.networkFee.toString()),
      };
      const resp = await enclaveFeedSignImpl({
        chain: 'neo_n3',
        symbols: SYMBOLS.filter((s) => s in prices),
        onchain_state: onchainState,
        now,
        tx_params: {
          nonce: txNonce,
          block_count: count,
          system_fee: txParams.systemFee,
          network_fee: txParams.networkFee,
        },
      });
      if (resp.status === 'no-update' || !Array.isArray(resp.pairs) || !resp.pairs.length) {
        log(`[neo-n3] enclave reported no updates (skipped ${skipped}, missing ${missing})`);
      } else {
        if (!resp.signature || typeof resp.signature !== 'string') {
          throw new Error('enclave /feed/sign returned no signature');
        }
        const rebuilt = rebuildUpdateFeedsTxFromEnclavePlan(resp, txParams);
        // Defense in depth: the host independently rebuilds the signed message and
        // refuses to broadcast unless it matches the enclave's tx_message_hex (so a
        // host/enclave plan or fee divergence can never attach a witness to a
        // different tx than the one the enclave actually signed).
        const returnedMsg = String(resp.tx_message_hex || '')
          .replace(/^0x/i, '')
          .toLowerCase();
        const rebuiltMsg = String(rebuilt.message || '').toLowerCase();
        if (!returnedMsg || returnedMsg !== rebuiltMsg) {
          throw new Error(
            '[neo-n3] enclave tx message mismatch — refusing to broadcast ' +
              `(enclave=${returnedMsg.slice(0, 24)}… host=${rebuiltMsg.slice(0, 24)}…)`
          );
        }
        if (Number.isInteger(resp.tx_nonce) && resp.tx_nonce !== txNonce) {
          throw new Error(
            `[neo-n3] enclave tx_nonce ${resp.tx_nonce} != pinned ${txNonce} — refusing to broadcast`
          );
        }
        rebuilt.txn.witnesses = [tx.Witness.fromSignature(resp.signature, N3_UPDATER_PUB)];
        const res = await n3rpc('sendrawtransaction', [
          u.HexString.fromHex(rebuilt.txn.serialize(true)).toBase64(),
        ]);
        log(
          `[neo-n3] (enclave) pushed ${resp.pairs.length} pairs (skipped ${skipped}, missing ${missing}), fee ${(txParams.systemFee / 1e8 + txParams.networkFee / 1e8).toFixed(5)} GAS, txid ${res && res.hash}`
        );
        // Host/enclave mapping divergence check — see enclaveDroppedStalePairs.
        for (const dropped of enclaveDroppedStalePairs(
          P,
          resp.pairs,
          onchainState,
          now,
          MAX_STALE_SEC
        )) {
          log(
            `[neo-n3] ⚠️ ALERT: ${dropped.symbol} was planned by this host but NOT written by the enclave, and is ${Math.round(dropped.age_seconds / 3600)}h stale on chain — the enclave EIF is fetching it with a different (older) provider-symbol mapping. Rebuild and re-run the enclave image so its baked feed-pusher.mjs matches this host.`
          );
        }
      }
    }
  }
  const g = await n3UpdaterGas();
  if (g >= 0 && g < N3_GAS_WARN)
    log(
      `[neo-n3] ⚠️ LOW GAS: updater ${g.toFixed(3)} < ${N3_GAS_WARN} — refund 0x${N3_UPDATER_SH}`
    );
}

// ── Neo X (EVM) chain: MorpheusPriceFeed, signed by the configured key ─────────
const NEOX_PK = process.env.NEOX_FEED_PK;
const NEOX_RPC = process.env.NEOX_RPC || 'https://mainnet-1.rpc.banelabs.org';
const NEOX_CHAIN_ID = Number(process.env.NEOX_CHAIN_ID || 47763);
const NEOX_FEED = process.env.NEOX_FEED || '0x38DD6BCEBDD47f4234AE11760CEFB58f9ae6a3bB';
const NEOX_GAS_WARN = Number(process.env.NEOX_GAS_WARN || 5);
// Neo X pushes real EVM gas every cycle, so it runs a crypto-only subset of the
// feed by default (TradFi forex/commodity quotes are dropped to save gas). Falls
// back to the full SYMBOLS list if NEOX_SYMBOLS is unset, so behaviour is
// unchanged unless explicitly configured. Neo N3 always uses the full SYMBOLS.
const NEOX_SYMBOLS = (
  process.env.NEOX_SYMBOLS ||
  process.env.SYMBOLS ||
  'NEO-USD,GAS-USD,BTC-USD,ETH-USD'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const NEOX_ABI = [
  'function updateFeeds(string[] symbols, uint256[] prices, uint256[] timestamps, uint256[] roundIds) external',
  'function getLatest(string symbol) view returns (uint256 price, uint256 timestamp, uint256 roundId, bool exists)',
];

// Phase D: the feed-updater EOA address (public) for the in-enclave EVM feed-sign
// path. The host needs it to read the nonce + gas balance and to assert the enclave
// signed with the expected key. This and MORPHEUS_FEED_PUSHER_ENCLAVE_SIGN are
// the explicit route gate; the currently shipped Rust frontier returns 503
// until a compatible measured secp256k1 signer is deployed. Unset does not
// authorize a production host-key fallback.
const NEOX_FEED_FROM = process.env.NEOX_FEED_FROM;
const NEOX_FEED_GAS_LIMIT = Number(process.env.NEOX_FEED_GAS_LIMIT || 3_000_000);
const ENCLAVE_FEED_SIGN = /^(1|true|yes|on)$/i.test(
  String(process.env.MORPHEUS_FEED_PUSHER_ENCLAVE_SIGN || '').trim()
);

export function resolveNeoXFeedSignerMode({
  nodeEnv = process.env.NODE_ENV,
  enclaveSign = false,
  enclaveSignerAddress = '',
  hostPrivateKey = '',
  allowInsecureHostSigner = false,
} = {}) {
  const production =
    String(nodeEnv || '')
      .trim()
      .toLowerCase() === 'production';
  const hasHostPrivateKey = Boolean(String(hostPrivateKey || '').trim());
  const hasEnclaveAddress = Boolean(String(enclaveSignerAddress || '').trim());
  if (production && hasHostPrivateKey) {
    throw new Error(
      'Neo X production feed signing refuses NEOX_FEED_PK on the host; configure the ' +
        'measured enclave signer path instead'
    );
  }
  if (enclaveSign || hasEnclaveAddress) {
    if (enclaveSign && hasEnclaveAddress) return 'enclave';
    throw new Error(
      'Neo X enclave signer configuration is incomplete; both ' +
        'MORPHEUS_FEED_PUSHER_ENCLAVE_SIGN and NEOX_FEED_FROM are required'
    );
  }
  if (!hasHostPrivateKey) {
    throw new Error(
      'Neo X feed signer is not configured; use the explicit enclave signer path ' +
        '(MORPHEUS_FEED_PUSHER_ENCLAVE_SIGN + NEOX_FEED_FROM)'
    );
  }
  if (!allowInsecureHostSigner) {
    throw new Error(
      'Neo X host feed signing is disabled; set MORPHEUS_ALLOW_INSECURE_HOST_EVM_SIGNER=true ' +
        'only for an explicit non-production test'
    );
  }
  return 'host_dev';
}

// Provider seam so the flag-on pushNeoX cycle is unit-testable without a live EVM RPC.
let neoxProviderImpl = null;
function neoxProvider(ethers) {
  return neoxProviderImpl || new ethers.JsonRpcProvider(NEOX_RPC, NEOX_CHAIN_ID);
}
export function __setNeoXProviderForTests(p) {
  neoxProviderImpl = p;
}
export function __resetNeoXProviderForTests() {
  neoxProviderImpl = null;
}

// Re-encode the updateFeeds calldata from the enclave's authoritative plan arrays so
// the host can assert the enclave-signed tx carries EXACTLY the prices it expects
// before broadcasting (the EVM analogue of pushNeoN3's tx_message_hex assert).
export function rebuildNeoXUpdateFeedsData(ethers, plan) {
  const iface = new ethers.Interface(NEOX_ABI);
  return iface.encodeFunctionData('updateFeeds', [
    plan.symbols,
    (plan.prices_scaled || []).map((x) => BigInt(x)),
    (plan.timestamps || []).map((x) => BigInt(x)),
    (plan.round_ids || []).map((x) => BigInt(x)),
  ]);
}

// Parse the enclave-signed updateFeeds tx and refuse it unless every host-pinned field
// (to/chainId/nonce/from) and the independently re-encoded calldata match. Returns the
// parsed tx; throws (fails closed) on any drift.
export function assertEnclaveNeoXTxMatches(ethers, resp, expected) {
  if (!resp || !resp.signed_tx) throw new Error('[neox] enclave /feed/sign returned no signed_tx');
  const parsed = ethers.Transaction.from(resp.signed_tx);
  const rebuiltData = rebuildNeoXUpdateFeedsData(ethers, resp);
  const need = (cond, msg) => {
    if (!cond) throw new Error(`[neox] enclave tx mismatch — refusing to broadcast (${msg})`);
  };
  need((parsed.to || '').toLowerCase() === String(expected.to).toLowerCase(), 'to');
  need(Number(parsed.chainId) === Number(expected.chainId), 'chainId');
  need(parsed.nonce === Number(expected.nonce), `nonce ${parsed.nonce}!=${expected.nonce}`);
  need(
    (parsed.from || '').toLowerCase() === String(expected.from).toLowerCase(),
    `from ${parsed.from}`
  );
  need(parsed.data === rebuiltData, 'calldata');
  return parsed;
}

async function pushNeoX(prices, now) {
  const signerMode = resolveNeoXFeedSignerMode({
    enclaveSign: ENCLAVE_FEED_SIGN,
    enclaveSignerAddress: NEOX_FEED_FROM,
    hostPrivateKey: NEOX_PK,
    allowInsecureHostSigner: /^(1|true|yes|on)$/i.test(
      String(process.env.MORPHEUS_ALLOW_INSECURE_HOST_EVM_SIGNER || '').trim()
    ),
  });
  const { ethers } = await import('ethers'); // lazy: only when NeoX enabled
  const provider = neoxProvider(ethers);
  const c = new ethers.Contract(NEOX_FEED, NEOX_ABI, provider);
  let skipped = 0,
    missing = 0;
  // Batched current-state reads: the per-symbol getLatest calls are independent
  // eth_call reads, so issue them in parallel (the symbol list is small and
  // bounded). Each read keeps its own zeroed-record fallback, and the results
  // are consumed in symbol order so the planned batch matches the sequential
  // path exactly.
  const reads = await Promise.all(
    NEOX_SYMBOLS.map(async (s) => {
      if (!(s in prices)) return { s, missing: true };
      let cur;
      try {
        cur = await c.getLatest('TWELVEDATA:' + s);
      } catch {
        cur = [0n, 0n, 0n, false];
      }
      return { s, cur };
    })
  );
  // On-chain state in planFeedUpdate's shape, in symbol order (shared by both paths).
  const onchainState = {};
  for (const read of reads) {
    if (read.missing) {
      missing++;
      continue;
    }
    // getLatest returns (price, timestamp, roundId, exists)
    onchainState[read.s] = {
      round: Number(read.cur[2]),
      price: Number(read.cur[0]) / 1e6,
      ts: Number(read.cur[1]),
    };
  }

  if (signerMode === 'enclave') {
    // Flag-on: the enclave fetches+plans+scales+signs the updateFeeds tx inside the
    // measured boundary with its KMS-materialized feed key. The host pins the nonce +
    // fees + gas (the tx the enclave signs), forwards the on-chain state it read so
    // the enclave plans against the same baseline, then independently re-encodes the
    // calldata + asserts the signed tx matches (to/chainId/nonce/from/data) before
    // broadcasting. The feed key never touches the host.
    const feeData = await provider.getFeeData();
    const nonce = await provider.getTransactionCount(NEOX_FEED_FROM, 'pending');
    const resp = await enclaveFeedSignImpl({
      chain: 'neox',
      symbols: NEOX_SYMBOLS.filter((s) => s in onchainState),
      onchain_state: onchainState,
      now,
      tx_params: {
        to: NEOX_FEED,
        chain_id: NEOX_CHAIN_ID,
        nonce,
        gas_limit: String(NEOX_FEED_GAS_LIMIT),
        max_fee_per_gas: String(feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n),
        max_priority_fee_per_gas: String(feeData.maxPriorityFeePerGas ?? 0n),
      },
    });
    if (resp.status === 'no-update' || !Array.isArray(resp.symbols) || !resp.symbols.length) {
      log(`[neox] (enclave) no updates (missing ${missing})`);
    } else {
      assertEnclaveNeoXTxMatches(ethers, resp, {
        to: NEOX_FEED,
        chainId: NEOX_CHAIN_ID,
        nonce,
        from: NEOX_FEED_FROM,
      });
      const sent = await provider.broadcastTransaction(resp.signed_tx);
      const rc = await sent.wait();
      log(
        `[neox] (enclave) pushed ${resp.symbols.length} pairs (missing ${missing}), gasUsed ${rc.gasUsed.toString()}, tx ${sent.hash}`
      );
    }
    const bal = Number(ethers.formatEther(await provider.getBalance(NEOX_FEED_FROM)));
    if (bal < NEOX_GAS_WARN)
      log(
        `[neox] ⚠️ LOW GAS: updater ${NEOX_FEED_FROM} ${bal.toFixed(3)} < ${NEOX_GAS_WARN} — fund it`
      );
    return;
  }

  // Explicit non-production compatibility path: plan inline + sign+submit
  // with NEOX_PK. resolveNeoXFeedSignerMode has already rejected production.
  const wallet2 = new ethers.Wallet(NEOX_PK, provider);
  const cw = new ethers.Contract(NEOX_FEED, NEOX_ABI, wallet2);
  const syms = [],
    px = [],
    ts = [],
    rounds = [];
  for (const s of NEOX_SYMBOLS) {
    if (!(s in onchainState)) continue; // missing from the price fetch (already counted)
    const plan = planFeedUpdate(onchainState[s], prices[s], now);
    if (!plan.push) {
      if (plan.rejected)
        log(
          `[neox] ⚠️ rejected ${s} ${plan.rejected}: src=${prices[s]} on-chain=${onchainState[s].price} (set MAX_DEVIATION_BPS=0 to override a real flash move)`
        );
      skipped++;
      continue;
    }
    syms.push('TWELVEDATA:' + s);
    px.push(BigInt(Math.round(prices[s] * 1e6)));
    ts.push(BigInt(plan.ts));
    rounds.push(BigInt(plan.round));
  }
  if (!syms.length) {
    log(`[neox] no updates (skipped ${skipped}, missing ${missing})`);
  } else {
    const tx2 = await cw.updateFeeds(syms, px, ts, rounds);
    const rc = await tx2.wait();
    log(
      `[neox] pushed ${syms.length} pairs (skipped ${skipped}, missing ${missing}), gasUsed ${rc.gasUsed.toString()}, tx ${tx2.hash}`
    );
  }
  const bal = Number(ethers.formatEther(await provider.getBalance(wallet2.address)));
  if (bal < NEOX_GAS_WARN)
    log(
      `[neox] ⚠️ LOW GAS: updater ${wallet2.address} ${bal.toFixed(3)} < ${NEOX_GAS_WARN} — fund it`
    );
}

// ── Multi-chain main loop ─────────────────────────────────────────────────────
// FEED_CHAINS (comma list) scopes a run to specific chains so each chain can run
// on its own timer cadence (e.g. neox every 2m, neo-n3 every 5m). Unset = all.
const FEED_CHAINS = (process.env.FEED_CHAINS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const CHAINS = [
  { name: 'neo-n3', enabled: true, symbols: SYMBOLS, push: pushNeoN3 },
  {
    name: 'neox',
    enabled: Boolean(NEOX_PK || (ENCLAVE_FEED_SIGN && NEOX_FEED_FROM)),
    symbols: NEOX_SYMBOLS,
    push: pushNeoX,
  },
].filter((c) => FEED_CHAINS.length === 0 || FEED_CHAINS.includes(c.name));

// FEED_PUSHER_SKIP_MAIN=1 lets tests import planFeedUpdate/parseGetLatestStack
// without running a live push cycle; the systemd entrypoint never sets it, so
// `node feed-pusher.mjs` behaves exactly as before.
if (process.env.FEED_PUSHER_SKIP_MAIN !== '1') {
  (async () => {
    const neoxEnabled = CHAINS.some((chain) => chain.name === 'neox' && chain.enabled);
    const neoxSelected = FEED_CHAINS.includes('neox') || neoxEnabled;
    if (neoxSelected && !neoxEnabled) {
      throw new Error(
        'Neo X feed lane selected without a signer; configure an attested enclave signer path'
      );
    }
    if (NEOX_PK || neoxEnabled) {
      resolveNeoXFeedSignerMode({
        enclaveSign: ENCLAVE_FEED_SIGN,
        enclaveSignerAddress: NEOX_FEED_FROM,
        hostPrivateKey: NEOX_PK,
        allowInsecureHostSigner: /^(1|true|yes|on)$/i.test(
          String(process.env.MORPHEUS_ALLOW_INSECURE_HOST_EVM_SIGNER || '').trim()
        ),
      });
    }
    const now = Math.floor(Date.now() / 1000);
    // Fetch only the prices the enabled chains actually need (each chain pushes its
    // own symbol list). Per-chain timers scope a run to one chain, so the neox unit
    // only fetches its crypto-only subset — saving both EVM gas and TwelveData quota.
    const fetchSet = [...new Set(CHAINS.filter((c) => c.enabled).flatMap((c) => c.symbols))];
    if (!fetchSet.length) {
      log('no enabled chains/symbols (nothing to fetch)');
      return;
    }
    let prices;
    try {
      prices = await td(fetchSet);
    } catch (e) {
      log('TD fetch error (skip cycle): ' + e.message);
      return;
    }
    // Consecutive-cycle missing-symbol alerting: only symbols this run actually
    // requested are counted (per-chain timer units leave the other chain's
    // counters untouched). A TD outage skips the cycle above, so misses here
    // mean TwelveData answered without that symbol.
    const { counts, alerts } = trackMissingSymbols(readMissingState(), fetchSet, prices);
    writeMissingState(counts);
    for (const alert of alerts) {
      log(
        `⚠️ ALERT: ${alert.symbol} missing from TwelveData for ${alert.cycles} consecutive cycles — prune it from SYMBOLS or fix the feed`
      );
    }
    for (const chain of CHAINS) {
      if (!chain.enabled) continue;
      try {
        await chain.push(prices, now);
      } catch (e) {
        log(`[${chain.name}] push error (recovers next cycle): ${e.message}`);
      }
    }
  })().catch((e) => {
    log('FATAL (recovers next cycle): ' + e.message);
    process.exitCode = 1;
  });
}
