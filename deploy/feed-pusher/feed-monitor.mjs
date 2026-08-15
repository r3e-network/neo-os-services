import { appendFileSync, writeFileSync, renameSync } from 'node:fs';
const RPCS = (
  process.env.FEED_RPCS ||
  'https://api.n3index.dev/mainnet,https://rpc10.n3.nspcc.ru:10331,https://mainnet1.neo.coz.io:443'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const FEED = '0x03013f49c42a14546c8bbe58f9d434c3517fccab',
  UPDATER = '0x9fb28bdacfaa7fcc0a4d660d0dc990b0e7d46118',
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
  (process.env.TRADFI_PAIRS || 'EUR-USD,GBP-USD,JPY-USD,CNY-USD,WTI-USD')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
);
const TRADFI_WEEKEND_AGE = Number(process.env.TRADFI_WEEKEND_AGE_SEC || 270000);
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
export function parseAllRecords(result, now) {
  if (!result || result.state !== 'HALT') return null;
  const records =
    result.stack && result.stack[0] && Array.isArray(result.stack[0].value)
      ? result.stack[0].value
      : [];
  const rows = [];
  for (const record of records) {
    const v = record && record.value;
    if (!Array.isArray(v) || v.length < 4) continue;
    const rawPair = Buffer.from(String(v[0].value || ''), 'base64').toString('utf8');
    if (!rawPair) continue;
    const pair = rawPair.replace(/^TWELVEDATA:/, '');
    const ts = Number(v[3].value || 0);
    rows.push({ pair, ts, age: now - ts });
  }
  return rows;
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
if (process.env.FEED_MONITOR_SKIP_MAIN !== '1') {
  const now = Math.floor(Date.now() / 1000);
  const date = new Date(now * 1000);
  const problems = [];
  try {
    // Per-pair iteration: read the FULL registry in one getAllFeedRecords invoke
    // so every registered pair is checked (not just NEO-USD). Fall back to the
    // single-pair getLatest if the batched invoke faults (older RPC / contract).
    let rows = null;
    try {
      rows = parseAllRecords(await rpc('invokefunction', [FEED, 'getAllFeedRecords', []]), now);
    } catch {
      rows = null;
    }
    if (!rows || rows.length === 0) {
      const j = await rpc('invokefunction', [
        FEED,
        'getLatest',
        [{ type: 'String', value: 'TWELVEDATA:NEO-USD' }],
      ]);
      // FeedRecord = [Pair, RoundId, Price, Timestamp, AttestationHash, SourceSetId]:
      // age comes from Timestamp (v[3]); RoundId only coincidentally tracks time
      // for the current pusher (round = max(cur+1, now)) and is a plain counter.
      const v = j.stack[0].value;
      rows = [{ pair: 'NEO-USD', ts: Number(v[3].value), age: now - Number(v[3].value) }];
    }
    for (const r of rows) {
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
          // feed_age_min retains its original meaning (NEO-USD age) for back-compat;
          // pairs[] carries the full per-pair view for the new monitoring path.
          feed_age_min: neo ? Math.round(neo.age / 60) : null,
          pairs: rows.map((r) => ({ pair: r.pair, age_min: Math.round(r.age / 60) })),
          updater_gas: gas,
          ok: problems.length === 0,
          problems,
        },
        null,
        2
      )
    );
    if (problems.length) {
      log('ALERT: ' + problems.join(' | '));
      process.exit(1);
    }
    log(
      `ok pairs=${rows.length}${neo ? ` feed_age=${Math.round(neo.age / 60)}min` : ''} gas=${gas.toFixed(1)}`
    );
  } catch (e) {
    log('monitor RPC error: ' + (e.message || e));
    process.exit(2);
  }
}
