import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import pkg from '@cityofzion/neon-js';
const { wallet, tx } = pkg;
import { ethers } from 'ethers';

process.env.FEED_PUSHER_SKIP_MAIN = '1';
// Pin a deterministic, single-symbol feed so the integration test is exact.
process.env.SYMBOLS = 'NEO-USD';
const {
  planFeedUpdate,
  parseGetLatestStack,
  parseGetAllFeedRecordsStack,
  trackMissingSymbols,
  rebuildUpdateFeedsTxFromEnclavePlan,
  pushNeoN3,
  rebuildNeoXUpdateFeedsData,
  assertEnclaveNeoXTxMatches,
  toTwelveDataSymbol,
  partitionMappedSymbols,
  assertTwelveDataResponse,
  enclaveDroppedStalePairs,
  TD_SYMBOLS,
  RETIRED_FEED_PAIRS,
  __setEnclaveFeedSignForTests,
  __resetEnclaveFeedSignForTests,
  __setN3RpcForTests,
  __resetN3RpcForTests,
} = await import('./feed-pusher.mjs');

const PUSHER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'feed-pusher.mjs');
const OPTS = { thresholdBps: 10, maxStaleSec: 1800 };

test('TwelveData HTTP errors fail the whole batch instead of becoming missing symbols', () => {
  assert.throws(
    () =>
      assertTwelveDataResponse(
        { ok: false, status: 401 },
        { status: 'error', code: 401, message: 'Your subscription has expired' }
      ),
    /HTTP 401, code 401.*subscription has expired/i
  );
});

test('TwelveData provider errors fail even when the transport returned HTTP 200', () => {
  assert.throws(
    () =>
      assertTwelveDataResponse(
        { ok: true, status: 200 },
        { status: 'error', code: 429, message: 'API credits exhausted' }
      ),
    /HTTP 200, code 429.*credits exhausted/i
  );
});

test('TwelveData validation accepts a normal price payload and redacts API keys in errors', () => {
  assert.doesNotThrow(() =>
    assertTwelveDataResponse({ ok: true, status: 200 }, { price: '1.23' })
  );
  assert.throws(
    () =>
      assertTwelveDataResponse(
        { ok: false, status: 401 },
        { message: 'See https://example.test/help?apikey=do-not-log-this&topic=billing' }
      ),
    (error) => {
      assert.doesNotMatch(error.message, /do-not-log-this/);
      assert.match(error.message, /apikey=<redacted>/);
      return true;
    }
  );
});

test('toTwelveDataSymbol maps equities/ETFs to bare tickers, crypto/forex to X/USD', () => {
  // Equities + ETFs must be the bare ticker (TwelveData 404s 'AAPL/USD').
  for (const s of ['AAPL', 'GOOGL', 'MSFT', 'AMZN', 'TSLA', 'META', 'NVDA', 'SPY', 'QQQ', 'GLD']) {
    assert.equal(toTwelveDataSymbol(`${s}-USD`), s);
  }
  // Crypto / forex stay in the X/USD pair form.
  assert.equal(toTwelveDataSymbol('BTC-USD'), 'BTC/USD');
  assert.equal(toTwelveDataSymbol('NEO-USD'), 'NEO/USD');
  assert.equal(toTwelveDataSymbol('EUR-USD'), 'EUR/USD');
  assert.equal(toTwelveDataSymbol('WTI-USD'), 'WTI/USD');
  assert.equal(toTwelveDataSymbol('PAXG-USD'), 'PAXG/USD');
  // FX is quoted directly as base/USD — nothing in this path inverts.
  assert.equal(toTwelveDataSymbol('JPY-USD'), 'JPY/USD');
  assert.equal(toTwelveDataSymbol('CNY-USD'), 'CNY/USD');
});

// Regression pin for the 2026-06 → 2026-08 CORN outage: the bare ticker 'CORN' is
// the Teucrium Corn Fund ETF (~$18.9), not CBOT corn futures (~479 c/bushel). Mapping
// CORN-USD to it made every cycle fail the deviation guard against the on-chain
// futures series, so the pair sat permanently stale and /api/feeds/status could
// never read healthy. The agricultural futures use the `X_1` symbols.
test('agricultural + energy commodities map to futures/spot symbols, never the ETF ticker', () => {
  assert.equal(toTwelveDataSymbol('CORN-USD'), 'C_1');
  assert.notEqual(toTwelveDataSymbol('CORN-USD'), 'CORN');
  assert.equal(toTwelveDataSymbol('WHEAT-USD'), 'W_1');
  assert.equal(toTwelveDataSymbol('SOY-USD'), 'S_1');
  assert.equal(toTwelveDataSymbol('BRENT-USD'), 'XBR/USD');
  assert.equal(toTwelveDataSymbol('NATGAS-USD'), 'NG/USD');
});

// The old heuristic silently invented a provider symbol for anything it was given
// (`FOO-USD` -> `FOO/USD`), which is how a wrong asset gets published under a right
// name. An unmapped pair must now be refused, not guessed.
test('an unmapped symbol is refused rather than guessed at', () => {
  assert.equal(toTwelveDataSymbol('FOO-USD'), null);
  const { mapped, unmapped } = partitionMappedSymbols(['NEO-USD', 'FOO-USD', 'CORN-USD']);
  assert.deepEqual(mapped, ['NEO-USD', 'CORN-USD']);
  assert.deepEqual(unmapped, ['FOO-USD']);
});

// Retired pairs are retired *because* the configured provider cannot serve them
// correctly. Re-adding one to the mapping table would put a wrong-asset price back
// on chain, so the two tables must stay disjoint.
test('retired pairs have no provider mapping', () => {
  assert.ok(RETIRED_FEED_PAIRS.has('COPPER-USD'));
  assert.ok(RETIRED_FEED_PAIRS.has('FLM-USD'));
  for (const [pair, reason] of RETIRED_FEED_PAIRS) {
    assert.equal(TD_SYMBOLS.has(pair), false, `${pair} is retired but still mapped`);
    assert.ok(String(reason).length > 20, `${pair} needs a real retirement reason`);
  }
});

// Distinct pairs sharing one provider symbol would collide in the batched
// /price?symbol=a,b,c response, which is keyed by provider symbol.
test('provider symbols are unique across pairs', () => {
  assert.equal(new Set(TD_SYMBOLS.values()).size, TD_SYMBOLS.size);
});

// With MORPHEUS_FEED_PUSHER_ENCLAVE_SIGN=true the enclave fetches and plans inside
// the measured boundary, so a host whose provider-symbol mapping has been fixed while
// the running EIF still carries the old one reports a clean "pushed N pairs" cycle
// forever while the affected pairs never move. This is the detector for that.
test('enclaveDroppedStalePairs reports only pairs the enclave skipped that were already stale', () => {
  const now = 1_800_000_000;
  const staleSec = 1800;
  const onchainState = {
    'NEO-USD': { round: 1, price: 1.86, timestamp: now - 60 },
    'CORN-USD': { round: 1, price: 417.4, timestamp: now - 75 * 86400 },
    'BRENT-USD': { round: 1, price: 92.9, timestamp: now - 75 * 86400 },
    'BTC-USD': { round: 1, price: 71590, timestamp: now - 120 },
  };
  const planned = [
    'TWELVEDATA:NEO-USD',
    'TWELVEDATA:CORN-USD',
    'TWELVEDATA:BRENT-USD',
    'TWELVEDATA:BTC-USD',
  ];
  const dropped = enclaveDroppedStalePairs(
    planned,
    ['TWELVEDATA:NEO-USD'],
    onchainState,
    now,
    staleSec
  );
  // CORN + BRENT: planned, not written, and long past the forced-heartbeat window.
  assert.deepEqual(dropped.map((entry) => entry.symbol).sort(), ['BRENT-USD', 'CORN-USD']);
  // BTC was also skipped by the enclave but is fresh — a benign disagreement between
  // two fetches a second apart, not a mapping fault. It must not raise an alert.
  assert.equal(
    dropped.some((entry) => entry.symbol === 'BTC-USD'),
    false
  );
});

test('enclaveDroppedStalePairs is silent when the enclave wrote everything the host planned', () => {
  const now = 1_800_000_000;
  const onchainState = { 'NEO-USD': { round: 1, price: 1.86, timestamp: now - 90000 } };
  assert.deepEqual(
    enclaveDroppedStalePairs(
      ['TWELVEDATA:NEO-USD'],
      ['TWELVEDATA:NEO-USD'],
      onchainState,
      now,
      1800
    ),
    []
  );
});

test('planFeedUpdate skips a recent round with an unchanged price', () => {
  const now = 1_780_000_000;
  const plan = planFeedUpdate({ round: now - 60, price: 100, ts: now - 60 }, 100.05, now, OPTS);
  assert.equal(plan.push, false);
});

test('planFeedUpdate pushes when the price moves past the threshold', () => {
  const now = 1_780_000_000;
  const plan = planFeedUpdate({ round: now - 60, price: 100, ts: now - 60 }, 100.2, now, OPTS);
  assert.equal(plan.push, true);
  // well under 10 bps stays skipped (the exact boundary is fp-noisy by design:
  // a move of exactly THRESHOLD_BPS may land a hair under 10 in float math)
  const skip = planFeedUpdate({ round: now - 60, price: 100, ts: now - 60 }, 100.05, now, OPTS);
  assert.equal(skip.push, false);
});

test('planFeedUpdate force-refreshes a stale round even when the price is flat', () => {
  const now = 1_780_000_000;
  const plan = planFeedUpdate({ round: now - 1801, price: 100, ts: now - 1801 }, 100, now, OPTS);
  assert.equal(plan.push, true);
});

test('planFeedUpdate pushes when there is no current record or a zero price', () => {
  const now = 1_780_000_000;
  assert.equal(planFeedUpdate({ round: 0, price: 0, ts: 0 }, 100, now, OPTS).push, true);
  assert.equal(
    planFeedUpdate({ round: now - 60, price: 0, ts: now - 60 }, 100, now, OPTS).push,
    true
  );
});

test('planFeedUpdate never regresses the on-chain timestamp or round', () => {
  const now = 1_780_000_000;
  // on-chain record carries a future timestamp (clock skew / prior writer):
  // the signed batch must keep it monotonic, not rewind to `now` — this is the
  // pusher-side guard for MorpheusPriceFeed.sol, which only checks roundId.
  // Price move (40%) is within the 50% deviation ceiling so it pushes; the
  // assertions below are about ts/round monotonicity, not the move magnitude.
  const plan = planFeedUpdate({ round: now + 100, price: 100, ts: now + 500 }, 140, now, OPTS);
  assert.equal(plan.push, true);
  assert.equal(plan.ts, now + 500);
  assert.equal(plan.round, now + 101);
  // normal case: fresh wall clock wins
  const fresh = planFeedUpdate({ round: now - 60, price: 100, ts: now - 60 }, 140, now, OPTS);
  assert.equal(fresh.ts, now);
  assert.equal(fresh.round, now);
});

test('planFeedUpdate rejects a non-positive or non-finite candidate price', () => {
  const now = 1_780_000_000;
  const cur = { round: now - 60, price: 100, ts: now - 60 };
  // Zero / negative source quote must never be pushed (would 0-price the feed).
  let plan = planFeedUpdate(cur, 0, now, OPTS);
  assert.equal(plan.push, false);
  assert.equal(plan.rejected, 'invalid_price');
  plan = planFeedUpdate(cur, -5, now, OPTS);
  assert.equal(plan.push, false);
  assert.equal(plan.rejected, 'invalid_price');
  // NaN / Infinity from a corrupt upstream parse are rejected too.
  for (const bad of [NaN, Infinity, -Infinity]) {
    const p = planFeedUpdate(cur, bad, now, OPTS);
    assert.equal(p.push, false);
    assert.equal(p.rejected, 'invalid_price');
  }
  // A rejected plan must never regress the stored round/timestamp.
  plan = planFeedUpdate(cur, 0, now, OPTS);
  assert.equal(plan.round, cur.round);
  assert.equal(plan.ts, cur.ts);
});

test('planFeedUpdate rejects a deviation spike against an existing on-chain price', () => {
  const now = 1_780_000_000;
  const cur = { round: now - 60, price: 100, ts: now - 60 };
  // Default 5000 bps (50%) ceiling: a 100 -> 1000 (900%) jump is a glitch.
  let plan = planFeedUpdate(cur, 1000, now, OPTS);
  assert.equal(plan.push, false);
  assert.equal(plan.rejected, 'deviation_spike');
  // A 100 -> 0.0001 collapse is symmetric and also rejected.
  plan = planFeedUpdate(cur, 0.0001, now, OPTS);
  assert.equal(plan.push, false);
  assert.equal(plan.rejected, 'deviation_spike');
  // A move within the deviation ceiling (40%) still pushes (past the bps threshold).
  plan = planFeedUpdate(cur, 140, now, OPTS);
  assert.equal(plan.push, true);
  assert.equal(plan.rejected, undefined);
});

test('planFeedUpdate honours the MAX_DEVIATION_BPS=0 admin override for genuine flash moves', () => {
  const now = 1_780_000_000;
  const cur = { round: now - 60, price: 100, ts: now - 60 };
  // maxDeviationBps=0 disables the spike guard so a real >50% candle lands.
  const plan = planFeedUpdate(cur, 1000, now, { ...OPTS, maxDeviationBps: 0 });
  assert.equal(plan.push, true);
  assert.equal(plan.rejected, undefined);
});

test('planFeedUpdate bootstrap (no on-chain price) bypasses the deviation guard but not the invalid-price guard', () => {
  const now = 1_780_000_000;
  // Bootstrap: cur.price<=0 has no usable reference, so any valid first price lands.
  assert.equal(planFeedUpdate({ round: 0, price: 0, ts: 0 }, 99999, now, OPTS).push, true);
  // ...but a zero/invalid first price is still rejected even at bootstrap.
  const bad = planFeedUpdate({ round: 0, price: 0, ts: 0 }, 0, now, OPTS);
  assert.equal(bad.push, false);
  assert.equal(bad.rejected, 'invalid_price');
});

test('parseGetLatestStack decodes the FeedRecord struct and tolerates faults', () => {
  const halt = {
    state: 'HALT',
    stack: [
      {
        type: 'Struct',
        value: [
          { type: 'ByteString', value: Buffer.from('TWELVEDATA:NEO-USD').toString('base64') },
          { type: 'Integer', value: '42' },
          { type: 'Integer', value: '5250000' },
          { type: 'Integer', value: '1780000000' },
          { type: 'ByteString', value: '' },
          { type: 'Integer', value: '0' },
        ],
      },
    ],
  };
  assert.deepEqual(parseGetLatestStack(halt), { round: 42, price: 5.25, ts: 1_780_000_000 });
  assert.deepEqual(parseGetLatestStack({ state: 'FAULT', stack: [] }), {
    round: 0,
    price: 0,
    ts: 0,
  });
  assert.deepEqual(parseGetLatestStack({ state: 'HALT', stack: [] }), {
    round: 0,
    price: 0,
    ts: 0,
  });
  assert.deepEqual(parseGetLatestStack(null), { round: 0, price: 0, ts: 0 });
});

test('feed-pusher still runs its main cycle when executed as the systemd entrypoint', () => {
  // FEED_CHAINS=none filters every chain out, so the cycle exits before any
  // network call — proving the entry path runs without touching live RPCs.
  const env = {
    ...process.env,
    FEED_CHAINS: 'none',
    PUSH_LOG: path.join(os.tmpdir(), 'feed-pusher-test.log'),
  };
  delete env.FEED_PUSHER_SKIP_MAIN;
  const result = spawnSync(process.execPath, [PUSHER], { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /no enabled chains\/symbols/);
});

test('FEED_PUSHER_SKIP_MAIN=1 suppresses the main cycle for test imports', () => {
  const env = {
    ...process.env,
    FEED_CHAINS: 'none',
    FEED_PUSHER_SKIP_MAIN: '1',
    PUSH_LOG: path.join(os.tmpdir(), 'feed-pusher-test.log'),
  };
  const result = spawnSync(process.execPath, [PUSHER], { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /no enabled chains\/symbols/);
});

test('parseGetAllFeedRecordsStack indexes the batched FeedRecords by pair', () => {
  const record = (pair, round, priceMicros, ts) => ({
    type: 'Struct',
    value: [
      { type: 'ByteString', value: Buffer.from(pair).toString('base64') },
      { type: 'Integer', value: String(round) },
      { type: 'Integer', value: String(priceMicros) },
      { type: 'Integer', value: String(ts) },
      { type: 'ByteString', value: '' },
      { type: 'Integer', value: '0' },
    ],
  });
  const halt = {
    state: 'HALT',
    stack: [
      {
        type: 'Array',
        value: [
          record('TWELVEDATA:NEO-USD', 42, 5250000, 1_780_000_000),
          record('TWELVEDATA:BTC-USD', 7, 65000000000, 1_780_000_100),
        ],
      },
    ],
  };
  const byPair = parseGetAllFeedRecordsStack(halt);
  // Equivalence with the per-pair getLatest decode for every indexed pair.
  assert.deepEqual(byPair.get('TWELVEDATA:NEO-USD'), {
    round: 42,
    price: 5.25,
    ts: 1_780_000_000,
  });
  assert.deepEqual(byPair.get('TWELVEDATA:BTC-USD'), {
    round: 7,
    price: 65000,
    ts: 1_780_000_100,
  });
  // Unregistered pairs are simply absent (callers default to the zeroed record).
  assert.equal(byPair.get('TWELVEDATA:FLM-USD'), undefined);
});

test('parseGetAllFeedRecordsStack returns null on FAULT so callers fall back to per-pair reads', () => {
  assert.equal(parseGetAllFeedRecordsStack({ state: 'FAULT', stack: [] }), null);
  assert.equal(parseGetAllFeedRecordsStack(null), null);
  // An empty registry still parses (no pairs registered yet).
  const empty = parseGetAllFeedRecordsStack({
    state: 'HALT',
    stack: [{ type: 'Array', value: [] }],
  });
  assert.equal(empty.size, 0);
});

test('trackMissingSymbols alerts only after N consecutive missing cycles and resets on recovery', () => {
  const requested = ['NEO-USD', 'GAS-USD', 'WTI-USD'];
  // Cycle 1: WTI missing -> counted, no alert yet.
  let state = trackMissingSymbols({}, requested, { 'NEO-USD': 5.2, 'GAS-USD': 2.1 }, 3);
  assert.deepEqual(state.counts, { 'WTI-USD': 1 });
  assert.deepEqual(state.alerts, []);
  // Cycle 2: still missing.
  state = trackMissingSymbols(state.counts, requested, { 'NEO-USD': 5.2, 'GAS-USD': 2.1 }, 3);
  assert.deepEqual(state.counts, { 'WTI-USD': 2 });
  assert.deepEqual(state.alerts, []);
  // Cycle 3: threshold reached -> alert, and keeps alerting while broken.
  state = trackMissingSymbols(state.counts, requested, { 'NEO-USD': 5.2, 'GAS-USD': 2.1 }, 3);
  assert.deepEqual(state.alerts, [{ symbol: 'WTI-USD', cycles: 3 }]);
  state = trackMissingSymbols(state.counts, requested, { 'NEO-USD': 5.2, 'GAS-USD': 2.1 }, 3);
  assert.deepEqual(state.alerts, [{ symbol: 'WTI-USD', cycles: 4 }]);
  // Recovery clears the counter entirely.
  state = trackMissingSymbols(state.counts, requested, {
    'NEO-USD': 5.2,
    'GAS-USD': 2.1,
    'WTI-USD': 70,
  });
  assert.deepEqual(state.counts, {});
  assert.deepEqual(state.alerts, []);
});

test('trackMissingSymbols leaves counters of symbols this run did not request untouched', () => {
  // Per-chain timer units fetch only their own symbol subset; the other
  // chain's counters must persist unmodified.
  const { counts } = trackMissingSymbols(
    { 'WTI-USD': 2, 'EUR-USD': 1 },
    ['NEO-USD'],
    { 'NEO-USD': 5.2 },
    3
  );
  assert.deepEqual(counts, { 'WTI-USD': 2, 'EUR-USD': 1 });
});

// ── Mandatory compute-in-enclave feed signing (/feed/sign) ──────────────────
// The enclave-server constants the host must reproduce byte-for-byte. These MUST
// stay identical to feed-pusher.mjs pushNeoN3 / the enclave-server.
const N3_UPDATER_PUB = '02f63e3f618d8f6995eb85279a03361beb715d25d3b97407c73c351d26ba849744';
const N3_MAGIC = 860833102;
const FEED_PRICE_SCALE = 1e6;

// Build the deterministic enclave /feed/sign response for a planned update, signed
// by `signerAccount` (a test key — the production updater key is never in tests).
// Mirrors enclave-server handleFeedSign: it returns the plan arrays + tx_nonce +
// valid_until_block + the signature over the SAME message the host rebuilds.
function buildEnclaveFeedSignResponse({ symbol, price, round, ts }, txParams, signerAccount) {
  const px = Math.round(price * FEED_PRICE_SCALE);
  const pair = 'TWELVEDATA:' + symbol;
  const attestationHash = createHash('sha256')
    .update(`${symbol}|${px}|${ts}`)
    .digest('hex')
    .slice(0, 32);
  const plan = {
    pairs: [pair],
    rounds: [round],
    prices_scaled: [px],
    timestamps: [ts],
    attestation_hashes: [attestationHash],
    source_set_ids: [0],
  };
  // The enclave builds the EXACT tx the host will rebuild and signs its message.
  const { message } = rebuildUpdateFeedsTxFromEnclavePlan(plan, txParams);
  const signature = wallet.sign(message, signerAccount.privateKey);
  return {
    status: 'ok',
    chain: 'neo_n3',
    ...plan,
    tx_message_hex: message,
    tx_nonce: txParams.nonce,
    valid_until_block: txParams.validUntilBlock,
    signature,
    public_key: signerAccount.publicKey,
    trust_tier: 'enclave-attested',
  };
}

test('rebuildUpdateFeedsTxFromEnclavePlan reproduces the enclave-signed tx (nonce + message) and the witness corresponds', () => {
  const signer = new wallet.Account(); // throwaway test updater key
  const txParams = {
    nonce: 0x1a2b3c4d,
    validUntilBlock: 5_000_500,
    systemFee: 1_234_567,
    networkFee: 234_567,
  };
  const enclave = buildEnclaveFeedSignResponse(
    { symbol: 'NEO-USD', price: 5.25, round: 1_780_000_000, ts: 1_780_000_000 },
    txParams,
    signer
  );

  // The host rebuilds the IDENTICAL tx from the enclave's authoritative plan +
  // the pinned tx_nonce + the same fees.
  const rebuilt = rebuildUpdateFeedsTxFromEnclavePlan(enclave, txParams);

  // (1) tx_nonce reproducibility: the rebuilt tx carries the pinned nonce.
  assert.equal(rebuilt.txn.nonce, txParams.nonce);
  assert.equal(enclave.tx_nonce, txParams.nonce);

  // (2) The host's message equals the enclave's tx_message_hex (so the witness is
  // attached to the SAME tx the enclave signed — the flag-on broadcast guard).
  assert.equal(rebuilt.message.toLowerCase(), String(enclave.tx_message_hex).toLowerCase());

  // (3) The witness corresponds: the enclave signature verifies over the rebuilt
  // message against the signer pubkey, and the witness verification script is the
  // signer's verification script.
  assert.equal(wallet.verify(rebuilt.message, enclave.signature, signer.publicKey), true);
  rebuilt.txn.witnesses = [tx.Witness.fromSignature(enclave.signature, signer.publicKey)];
  assert.equal(
    rebuilt.txn.witnesses[0].verificationScript.toBigEndian(),
    wallet.getVerificationScriptFromPublicKey(signer.publicKey)
  );
  // The invocation script embeds the 64-byte signature (0c40 push prefix + sig).
  assert.match(rebuilt.txn.witnesses[0].invocationScript.toBigEndian(), /^0c40[0-9a-f]{128}$/);
});

test('rebuildUpdateFeedsTxFromEnclavePlan signs against the production updater verification script when given its pubkey', () => {
  // The production tx pins N3_UPDATER_PUB as the signer; the rebuild must use that
  // pubkey's script hash so the signer matches the deployed feed updater. (We can't
  // sign with the production key, so this asserts only the signer-script binding.)
  const txParams = {
    nonce: 7,
    validUntilBlock: 100500,
    systemFee: 100,
    networkFee: 50,
  };
  const px = Math.round(2.1 * FEED_PRICE_SCALE);
  const plan = {
    pairs: ['TWELVEDATA:GAS-USD'],
    rounds: [42],
    prices_scaled: [px],
    timestamps: [1_780_000_000],
    attestation_hashes: [
      createHash('sha256')
        .update('GAS-USD|' + px + '|1780000000')
        .digest('hex')
        .slice(0, 32),
    ],
    source_set_ids: [0],
  };
  const rebuilt = rebuildUpdateFeedsTxFromEnclavePlan(plan, txParams);
  const expectedSignerScriptHash = wallet.getScriptHashFromPublicKey(N3_UPDATER_PUB);
  assert.equal(rebuilt.txn.signers[0].account.toBigEndian(), expectedSignerScriptHash);
  // getMessageForSigning is deterministic for the pinned nonce (reproducible).
  const again = rebuildUpdateFeedsTxFromEnclavePlan(plan, txParams);
  assert.equal(rebuilt.message, again.message);
});

test('pushNeoN3 delegates compute+sign to mandatory enclave /feed/sign and broadcasts the enclave-signed tx', async () => {
  const signer = new wallet.Account(); // throwaway test updater key
  const blockCount = 5_000_000;
  const gasConsumed = '1234567';
  const networkFee = '234567';
  const now = 1_780_000_000;

  // Mock the Neo RPC layer the flag-on pushNeoN3 touches, in the order it calls.
  const broadcast = [];
  __setN3RpcForTests(async (method, params) => {
    switch (method) {
      case 'invokefunction':
        // getAllFeedRecords (state read) -> empty registry (bootstrap write).
        if (params[1] === 'getAllFeedRecords') {
          return { state: 'HALT', stack: [{ type: 'Array', value: [] }] };
        }
        // balanceOf (n3UpdaterGas) -> healthy balance.
        if (params[1] === 'balanceOf') {
          return { state: 'HALT', stack: [{ type: 'Integer', value: String(20 * 1e8) }] };
        }
        throw new Error('unexpected invokefunction ' + params[1]);
      case 'getblockcount':
        return blockCount;
      case 'invokescript':
        return { state: 'HALT', gasconsumed: gasConsumed };
      case 'calculatenetworkfee':
        return { networkfee: networkFee };
      case 'sendrawtransaction':
        broadcast.push(params[0]);
        return { hash: '0xbroadcasted' };
      default:
        throw new Error('unexpected rpc ' + method);
    }
  });

  // Mock the enclave: echo the pinned tx_params, plan the single symbol, and sign
  // the SAME message the host will rebuild (using rebuildUpdateFeedsTxFromEnclavePlan
  // with the host-supplied nonce/fees). This is the byte-exact reproduction contract.
  let enclaveRequest = null;
  let enclaveSignature = null;
  __setEnclaveFeedSignForTests(async (requestBody) => {
    enclaveRequest = requestBody;
    const p = requestBody.tx_params;
    const txParams = {
      nonce: p.nonce,
      validUntilBlock: p.block_count + 500,
      systemFee: p.system_fee,
      networkFee: p.network_fee,
    };
    // Bootstrap: empty on-chain state -> round/ts = now (planFeedUpdate bootstrap).
    // The enclave signs the rebuilt message with a test key (the production updater
    // key is never available in tests); the host attaches it under the pinned
    // N3_UPDATER_PUB, so the integration assertion checks the host attached the
    // ENCLAVE'S EXACT signature under the pinned updater pubkey. (The cryptographic
    // verify-against-the-signing-key check lives in the rebuild unit test above,
    // where both keys are controlled.)
    const resp = buildEnclaveFeedSignResponse(
      { symbol: 'NEO-USD', price: 5.25, round: now, ts: now },
      txParams,
      signer
    );
    enclaveSignature = resp.signature;
    return resp;
  });

  try {
    await pushNeoN3({ 'NEO-USD': 5.25 }, now);

    // The enclave was asked to compute+sign, carrying the on-chain state + pinned
    // tx_params (the reproducibility key) the host read.
    assert.ok(enclaveRequest, 'enclave /feed/sign must be called in flag-on mode');
    assert.equal(enclaveRequest.chain, 'neo_n3');
    assert.deepEqual(enclaveRequest.symbols, ['NEO-USD']);
    assert.equal(Number.isInteger(enclaveRequest.tx_params.nonce), true);
    assert.equal(enclaveRequest.tx_params.block_count, blockCount);
    assert.equal(enclaveRequest.tx_params.system_fee, Number(gasConsumed));
    assert.equal(enclaveRequest.tx_params.network_fee, Number(networkFee));

    // Exactly one tx was broadcast (the enclave-signed one), and it deserializes
    // to a tx with the pinned tx_nonce.
    assert.equal(broadcast.length, 1, 'expected exactly one enclave-signed broadcast');
    const raw = Buffer.from(broadcast[0], 'base64').toString('hex');
    const broadcastTx = tx.Transaction.deserialize(raw);
    assert.equal(
      broadcastTx.nonce,
      enclaveRequest.tx_params.nonce,
      'broadcast nonce == enclave tx_nonce'
    );
    assert.equal(broadcastTx.witnesses.length, 1, 'broadcast tx carries the enclave witness');

    // The witness corresponds: the host attached the ENCLAVE'S returned signature
    // (invocation script = 0c40 push + the exact enclave signature) under the
    // pinned updater verification script (the contract-recognized updater key).
    const invocation = broadcastTx.witnesses[0].invocationScript.toBigEndian();
    assert.equal(invocation, '0c40' + enclaveSignature.toLowerCase());
    assert.equal(
      broadcastTx.witnesses[0].verificationScript.toBigEndian(),
      wallet.getVerificationScriptFromPublicKey(N3_UPDATER_PUB),
      'witness uses the pinned updater verification script'
    );

    // And the message the enclave signed equals the broadcast tx's signing message
    // (the host rebuilt the IDENTICAL tx the enclave signed before broadcasting).
    const broadcastMessage = broadcastTx.getMessageForSigning(N3_MAGIC);
    assert.equal(
      wallet.verify(broadcastMessage, enclaveSignature, signer.publicKey),
      true,
      'enclave signature verifies over the broadcast tx signing message'
    );
  } finally {
    __resetEnclaveFeedSignForTests();
    __resetN3RpcForTests();
  }
});

test('pushNeoN3 refuses to broadcast when the enclave tx message diverges from the host rebuild', async () => {
  const signer = new wallet.Account();
  const blockCount = 5_000_000;
  const now = 1_780_000_000;
  const broadcast = [];
  __setN3RpcForTests(async (method, params) => {
    switch (method) {
      case 'invokefunction':
        if (params[1] === 'getAllFeedRecords')
          return { state: 'HALT', stack: [{ type: 'Array', value: [] }] };
        if (params[1] === 'balanceOf')
          return { state: 'HALT', stack: [{ type: 'Integer', value: String(20 * 1e8) }] };
        throw new Error('unexpected invokefunction ' + params[1]);
      case 'getblockcount':
        return blockCount;
      case 'invokescript':
        return { state: 'HALT', gasconsumed: '1000000' };
      case 'calculatenetworkfee':
        return { networkfee: '200000' };
      case 'sendrawtransaction':
        broadcast.push(params[0]);
        return { hash: '0xnope' };
      default:
        throw new Error('unexpected rpc ' + method);
    }
  });
  // Enclave returns a VALID-looking response but signs a tx with a DIFFERENT price
  // (round mismatch) than the host rebuild expects from the returned plan — actually
  // return a tx_message_hex that does not match the rebuilt message.
  __setEnclaveFeedSignForTests(async (requestBody) => {
    const p = requestBody.tx_params;
    const txParams = {
      nonce: p.nonce,
      validUntilBlock: p.block_count + 500,
      systemFee: p.system_fee,
      networkFee: p.network_fee,
    };
    const resp = buildEnclaveFeedSignResponse(
      { symbol: 'NEO-USD', price: 5.25, round: now, ts: now },
      txParams,
      signer
    );
    // Tamper: corrupt the returned message so the host's rebuild can't match it.
    resp.tx_message_hex = 'deadbeef' + String(resp.tx_message_hex).slice(8);
    return resp;
  });

  try {
    await assert.rejects(() => pushNeoN3({ 'NEO-USD': 5.25 }, now), /enclave tx message mismatch/);
    assert.equal(broadcast.length, 0, 'must NOT broadcast on a message mismatch (fails closed)');
  } finally {
    __resetEnclaveFeedSignForTests();
    __resetN3RpcForTests();
  }
});

// ── Phase D: in-TEE EVM (Neo X) feed-sign host-side assert helpers ──────────────
test('neox enclave feed-sign: host re-encodes the calldata + accepts a matching signed tx', async () => {
  const FEED_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
  const from = new ethers.Wallet(FEED_PK).address;
  const TO = '0x38DD6BCEBDD47f4234AE11760CEFB58f9ae6a3bB';
  const plan = {
    status: 'ok',
    symbols: ['TWELVEDATA:NEO-USD', 'TWELVEDATA:BTC-USD'],
    prices_scaled: ['5250000', '65000123456'],
    timestamps: ['1780000000', '1780000000'],
    round_ids: ['1', '1'],
  };
  const data = rebuildNeoXUpdateFeedsData(ethers, plan);
  const signed_tx = await new ethers.Wallet(FEED_PK).signTransaction({
    type: 2,
    chainId: 47763,
    nonce: 7,
    to: TO,
    value: 0n,
    data,
    gasLimit: 2_000_000n,
    maxFeePerGas: 50_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  const resp = { ...plan, signed_tx };

  // The enclave-side encode equals the host-side re-encode (cross-check).
  const iface = new ethers.Interface([
    'function updateFeeds(string[] symbols, uint256[] prices, uint256[] timestamps, uint256[] roundIds) external',
  ]);
  assert.equal(
    data,
    iface.encodeFunctionData('updateFeeds', [
      plan.symbols,
      plan.prices_scaled.map((x) => BigInt(x)),
      plan.timestamps.map((x) => BigInt(x)),
      plan.round_ids.map((x) => BigInt(x)),
    ])
  );

  // A matching signed tx is accepted; the parsed tx is returned.
  const parsed = assertEnclaveNeoXTxMatches(ethers, resp, {
    to: TO,
    chainId: 47763,
    nonce: 7,
    from,
  });
  assert.equal(parsed.nonce, 7);
  assert.equal(parsed.from.toLowerCase(), from.toLowerCase());
  assert.equal(parsed.data, data);
});

test('neox enclave feed-sign: host refuses to broadcast on any tx drift (fails closed)', async () => {
  const FEED_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
  const from = new ethers.Wallet(FEED_PK).address;
  const TO = '0x38DD6BCEBDD47f4234AE11760CEFB58f9ae6a3bB';
  const plan = {
    status: 'ok',
    symbols: ['TWELVEDATA:NEO-USD'],
    prices_scaled: ['5250000'],
    timestamps: ['1780000000'],
    round_ids: ['1'],
  };
  const data = rebuildNeoXUpdateFeedsData(ethers, plan);
  const signed_tx = await new ethers.Wallet(FEED_PK).signTransaction({
    type: 2,
    chainId: 47763,
    nonce: 7,
    to: TO,
    value: 0n,
    data,
    gasLimit: 2_000_000n,
    maxFeePerGas: 50_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  const resp = { ...plan, signed_tx };

  assert.throws(
    () => assertEnclaveNeoXTxMatches(ethers, resp, { to: TO, chainId: 47763, nonce: 8, from }),
    /nonce/
  );
  assert.throws(
    () =>
      assertEnclaveNeoXTxMatches(ethers, resp, {
        to: TO,
        chainId: 47763,
        nonce: 7,
        from: '0x0000000000000000000000000000000000000001',
      }),
    /from/
  );
  assert.throws(
    () =>
      assertEnclaveNeoXTxMatches(ethers, resp, {
        to: '0x0000000000000000000000000000000000000002',
        chainId: 47763,
        nonce: 7,
        from,
      }),
    /to/
  );
  // Tampered plan (price) → the re-encoded calldata no longer matches the signed tx.
  assert.throws(
    () =>
      assertEnclaveNeoXTxMatches(
        ethers,
        { ...resp, prices_scaled: ['9999999'] },
        { to: TO, chainId: 47763, nonce: 7, from }
      ),
    /calldata/
  );
  // Missing signed_tx.
  assert.throws(
    () =>
      assertEnclaveNeoXTxMatches(ethers, { ...plan }, { to: TO, chainId: 47763, nonce: 7, from }),
    /signed_tx/
  );
});
