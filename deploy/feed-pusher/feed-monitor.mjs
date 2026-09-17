import { appendFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

async function loadFeedNetworkLibrary() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, 'lib-feed-network.mjs'),
    path.join(process.cwd(), 'lib-feed-network.mjs'),
    path.join(process.cwd(), 'deploy/feed-pusher/lib-feed-network.mjs'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return import(pathToFileURL(candidate).href);
  }
  throw new Error(
    'lib-feed-network.mjs is missing. Install it beside this script or under deploy/feed-pusher/ — do not copy only feed-monitor.mjs'
  );
}

const feedNetwork = await loadFeedNetworkLibrary();
const {
  DEFAULT_RETIRED_FEED_PAIRS,
  decodeGetAllFeedRecords,
  readChainUnixTime,
  resolveFeedNetwork,
  selectRpcsMatchingMagic,
} = feedNetwork;
const CLOCK_SKEW_TOLERANCE_SEC = Number(feedNetwork.CLOCK_SKEW_TOLERANCE_SEC) || 120;

const FEED_TARGET = resolveFeedNetwork(process.env);
const CONFIGURED_RPCS = (process.env.FEED_RPCS || FEED_TARGET.rpcs.join(','))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
let RPCS = CONFIGURED_RPCS;
const FEED = `0x${FEED_TARGET.feed}`,
  UPDATER = `0x${FEED_TARGET.updaterSh}`,
  GASH = '0xd2a4cff31913016155e38e474a2c06d08be276cf';
// Network label for the Prometheus metrics (this monitor watches the Neo N3
// MorpheusDataFeed; a second timer unit can run it against another chain by
// overriding FEED/UPDATER/RPCS + MONITOR_NETWORK).
const NETWORK = process.env.MONITOR_NETWORK || 'neo-n3';
// Alert only on GENUINE staleness, i.e. above the pusher's own force-refresh
// interval (MAX_STALE_SEC) plus margin. A flat symbol legitimately ages up to
// MAX_STALE_SEC + a push cycle before its scheduled refresh, so a tighter
// threshold (the old 1200s) false-alarms whenever the price simply hasn't moved.
const STALE_REFRESH = Number(process.env.MAX_STALE_SEC || 1800);
const MAX_AGE = Number(process.env.MAX_AGE_SEC || STALE_REFRESH + 900),
  MIN_GAS = Number(process.env.MIN_GAS || 12);
// TradFi pairs (forex / commodities) don't trade on weekends/holidays, so their
// on-chain price legitimately ages across a market close. Widen their staleness
// window by TRADFI_WEEKEND_AGE_SEC (default ~3.1 days, covering Fri-close →
// Mon-open plus margin) when the market is closed; crypto pairs keep MAX_AGE.
// TRADFI_PAIRS is the configurable suffix list (pair string sans TWELVEDATA:).
const TRADFI_PAIRS = new Set(
  (
    process.env.TRADFI_PAIRS ||
    'EUR-USD,GBP-USD,JPY-USD,CNY-USD,WTI-USD,BRENT-USD,NATGAS-USD,WHEAT-USD,CORN-USD,SOY-USD'
  )
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
);
const TRADFI_WEEKEND_AGE = Number(process.env.TRADFI_WEEKEND_AGE_SEC || 270000);
// Retired pairs: records that still exist on chain but that no writer pushes any
// more, because the configured provider cannot serve them correctly. They age
// forever by design, so counting them as staleness makes this monitor permanently
// red — and a monitor that is always red is a monitor nobody reads, which is how a
// 22-day outage went unnoticed. They are excluded from the ALERT check but still
// reported in feed-status.json (flagged `retired`) and in the Prometheus text, so
// they stay visible rather than being hidden.
//
// Keep in sync with RETIRED_FEED_PAIRS in feed-pusher.mjs, apps/web/lib/feed-defaults.ts
// and workers/nitro-worker/src/oracle/feed-registry.js — enforced by
// scripts/check-feed-pair-registries.mjs.
const RETIRED_PAIRS = new Set(
  (process.env.RETIRED_PAIRS || DEFAULT_RETIRED_FEED_PAIRS.join(','))
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
);
export function isRetiredPair(pair, { retiredPairs = RETIRED_PAIRS } = {}) {
  return retiredPairs.has(String(pair).toUpperCase());
}

// Extra holiday dates (UTC YYYY-MM-DD, comma list) on which TradFi markets are
// closed mid-week — they get the widened window too. Empty by default.
const TRADFI_HOLIDAYS = new Set(
  (process.env.TRADFI_HOLIDAYS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);
const LOG = process.env.MONITOR_LOG || '/opt/morpheus/nitro/feed-monitor.log',
  STATUS = process.env.MONITOR_STATUS || '/opt/morpheus/nitro/feed-status.json';
// Prometheus node_exporter textfile-collector output. Off by default (no file
// written) so the live box behaves identically until MONITOR_PROM_TEXTFILE is
// set to a path under the textfile collector directory.
const PROM_TEXTFILE = process.env.MONITOR_PROM_TEXTFILE || '';
const log = (m) => {
  const l = `[${new Date().toISOString()}] ${m}`;
  try {
    appendFileSync(LOG, l + '\n');
  } catch {}
  console.log(l);
};
async function rpc(m, p) {
  let last;
  for (const url of RPCS) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }),
        signal: AbortSignal.timeout(12000),
      });
      const t = await r.text();
      let j;
      try {
        j = JSON.parse(t);
      } catch {
        throw new Error('non-JSON');
      }
      if (j.error) throw new Error('rpcerr');
      return j.result;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

// Decode the batched getAllFeedRecords stack into { pair, age } rows. `pair` is
// the on-chain pair string with the TWELVEDATA: prefix stripped (e.g. NEO-USD).
// FeedRecord = [Pair, RoundId, Price, Timestamp, AttestationHash, SourceSetId].
// FAULT / empty / malformed / any undecodable row is a hard failure — a fresh
// NEO-USD getLatest must never upgrade an unreadable registry to healthy.
export function parseAllRecords(result, now) {
  const decoded = decodeGetAllFeedRecords(result);
  return {
    ok: decoded.ok,
    reason: decoded.reason,
    record_count: decoded.record_count,
    decoded_count: decoded.decoded_count,
    undecodable_count: decoded.undecodable_count,
    rows: decoded.ok
      ? decoded.rows.map((row) => {
          const ts = Number(row.timestamp);
          const age = now - ts;
          return {
            pair: String(row.pair).replace(/^TWELVEDATA:/, ''),
            ts,
            age,
            clock_skew: Number.isFinite(age) && age < -CLOCK_SKEW_TOLERANCE_SEC,
          };
        })
      : [],
  };
}

// Pure staleness predicate (exported for tests): TradFi pairs get the widened
// window while their market is closed (weekend, or a configured holiday).
export function isMarketClosed(date, { tradfiHolidays = TRADFI_HOLIDAYS } = {}) {
  const day = date.getUTCDay(); // 0 = Sun, 6 = Sat
  if (day === 0 || day === 6) return true;
  const ymd = date.toISOString().slice(0, 10);
  return tradfiHolidays.has(ymd);
}

export function staleAgeLimit(
  pair,
  date,
  {
    maxAge = MAX_AGE,
    tradfiPairs = TRADFI_PAIRS,
    tradfiWeekendAge = TRADFI_WEEKEND_AGE,
    tradfiHolidays = TRADFI_HOLIDAYS,
  } = {}
) {
  if (tradfiPairs.has(String(pair).toUpperCase()) && isMarketClosed(date, { tradfiHolidays }))
    return Math.max(maxAge, tradfiWeekendAge);
  return maxAge;
}

// Atomic Prometheus textfile write (temp + rename) so a partial write is never
// scraped. Each pair emits feed_age_seconds{pair,network}; the updater GAS
// balance emits feed_updater_gas{network}.
export function renderPromText(rows, gas, network = NETWORK) {
  const lines = [
    '# HELP feed_age_seconds Seconds since the on-chain feed timestamp for a pair.',
    '# TYPE feed_age_seconds gauge',
  ];
  for (const r of rows)
    lines.push(`feed_age_seconds{pair="${r.pair}",network="${network}"} ${r.age}`);
  lines.push('# HELP feed_updater_gas Updater account GAS balance.');
  lines.push('# TYPE feed_updater_gas gauge');
  if (Number.isFinite(gas)) lines.push(`feed_updater_gas{network="${network}"} ${gas}`);
  return lines.join('\n') + '\n';
}

function writePromTextfile(rows, gas) {
  if (!PROM_TEXTFILE) return;
  try {
    const tmp = PROM_TEXTFILE + '.tmp';
    writeFileSync(tmp, renderPromText(rows, gas));
    renameSync(tmp, PROM_TEXTFILE);
  } catch (e) {
    log('prom textfile write failed: ' + (e.message || e));
  }
}

// FEED_MONITOR_SKIP_MAIN=1 lets tests import the pure helpers without running a
// live cycle; the systemd entrypoint never sets it.
function writeUnreadableStatus(reason, extra = {}) {
  writeFileSync(
    STATUS,
    JSON.stringify(
      {
        ts: new Date().toISOString(),
        network: FEED_TARGET.network,
        feed: FEED,
        updater: UPDATER,
        ok: false,
        unreadable_reason: reason,
        problems: [`getAllFeedRecords ${reason}`],
        ...extra,
      },
      null,
      2
    )
  );
}

if (process.env.FEED_MONITOR_SKIP_MAIN !== '1') {
  const wallNow = Math.floor(Date.now() / 1000);
  const problems = [];
  try {
    const selected = await selectRpcsMatchingMagic(CONFIGURED_RPCS, FEED_TARGET.magic);
    RPCS = selected.matched;
    let now = wallNow;
    try {
      now = await readChainUnixTime((method, params) => rpc(method, params));
    } catch {
      now = wallNow;
    }
    const date = new Date(now * 1000);
    const decoded = parseAllRecords(
      await rpc('invokefunction', [FEED, 'getAllFeedRecords', []]),
      now
    );
    if (!decoded.ok) {
      writeUnreadableStatus(decoded.reason, {
        record_count: decoded.record_count,
        decoded_count: decoded.decoded_count,
        undecodable_count: decoded.undecodable_count,
      });
      log(`ALERT: getAllFeedRecords ${decoded.reason} (fail-closed, not healthy)`);
      process.exit(2);
    }
    const rows = decoded.rows;
    const clockSkewRows = rows.filter((r) => r.clock_skew && !isRetiredPair(r.pair));
    for (const r of rows) {
      // A retired pair has no writer, so its age is expected, not a fault.
      if (isRetiredPair(r.pair)) continue;
      if (r.clock_skew) {
        problems.push(`CLOCK SKEW ${r.pair} ahead=${Math.abs(r.age)}s`);
        continue;
      }
      const limit = staleAgeLimit(r.pair, date);
      if (r.age > limit) problems.push(`FEED STALE ${r.pair} age=${(r.age / 60).toFixed(0)}min`);
    }
    const g = await rpc('invokefunction', [
      GASH,
      'balanceOf',
      [{ type: 'Hash160', value: UPDATER }],
    ]);
    const gas = Number(g.stack[0].value) / 1e8;
    if (gas < MIN_GAS) problems.push(`LOW GAS updater=${gas.toFixed(1)} (refund ${UPDATER})`);
    writePromTextfile(rows, gas);
    const neo = rows.find((r) => r.pair === 'NEO-USD');
    writeFileSync(
      STATUS,
      JSON.stringify(
        {
          ts: new Date().toISOString(),
          network: FEED_TARGET.network,
          feed: FEED,
          updater: UPDATER,
          // feed_age_min retains its original meaning (NEO-USD age) for back-compat;
          // pairs[] carries the full per-pair view for the new monitoring path.
          feed_age_min: neo ? Math.round(neo.age / 60) : null,
          pairs: rows.map((r) => ({
            pair: r.pair,
            age_min: Math.round(r.age / 60),
            age_seconds: r.age,
            retired: isRetiredPair(r.pair),
            clock_skew: Boolean(r.clock_skew),
          })),
          updater_gas: gas,
          clock_skew: clockSkewRows.length > 0,
          ok: problems.length === 0,
          problems,
        },
        null,
        2
      )
    );
    if (clockSkewRows.length) {
      log('ALERT: ' + problems.join(' | '));
      process.exit(2);
    }
    if (problems.length) {
      log('ALERT: ' + problems.join(' | '));
      process.exit(1);
    }
    log(
      `ok pairs=${rows.length} (retired ${rows.filter((r) => isRetiredPair(r.pair)).length})${neo ? ` feed_age=${Math.round(neo.age / 60)}min` : ''} gas=${gas.toFixed(1)}`
    );
  } catch (e) {
    log('monitor RPC error: ' + (e.message || e));
    process.exit(2);
  }
}
