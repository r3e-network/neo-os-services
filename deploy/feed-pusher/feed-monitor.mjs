import { appendFileSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
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
  FEED_UNIT_PINNED_ENV,
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
// Runway (CU-11). Every write the updater makes costs GAS: 0.00606339 GAS each on 2026-09-30 (a
// two-pair write; a batch of many pairs costs more), when it made 752 of them (about 4.56 GAS a day,
// four times the plan) and ran dry on 2026-10-01 while this monitor's only balance alert was a fixed
// floor. The monitor now keeps its own balance samples next to MONITOR_STATUS (so a TestNet monitor
// and a mainnet monitor never share them), derives the burn from the recent decline, and alerts on
// days left, not on a fixed balance.
export const OBSERVED_FEE_PER_WRITE_GAS = 0.00606339;
const FEE_PER_WRITE_GAS = (() => {
  const configured = Number(process.env.FEED_WRITE_FEE_GAS);
  return Number.isFinite(configured) && configured > 0 ? configured : OBSERVED_FEE_PER_WRITE_GAS;
})();
const BALANCE_HISTORY = `${STATUS}.balance-samples.json`;
// The writer's own report of its last cycle (a provider failure lands there as
// provider_category). It sits beside this monitor's status under the name the units pin.
const WRITER_STATUS = path.join(
  path.dirname(STATUS),
  path.basename(
    FEED_UNIT_PINNED_ENV[
      FEED_TARGET.network === 'testnet'
        ? 'morpheus-feed-pusher-testnet.service'
        : 'morpheus-feed-pusher.service'
    ].PUSH_STATUS
  )
);
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

// ── Alert levels, runway, provider failure (CU-11) ────────────────────────────
// Every level other than "ok" makes the unit fail, which is what delivers the page
// (OnFailure=morpheus-alert@%n.service). The level says how urgent it is to whoever reads it.
export const ALERT_LEVELS = Object.freeze(['ok', 'warning', 'high', 'critical']);

export function maxAlertLevel(levels = []) {
  let rank = 0;
  for (const level of levels) {
    const index = ALERT_LEVELS.indexOf(level);
    if (index > rank) rank = index;
  }
  return ALERT_LEVELS[rank];
}

// Days of runway at which each level starts: 14, 7 and 3.
export const RUNWAY_ALERT_DAYS = Object.freeze({ warning: 14, high: 7, critical: 3 });

// An unknown or unbounded runway raises no runway alert by itself: with no history there is nothing
// to estimate from (the fixed floor and the stale checks still apply), and a balance that is not
// falling has no end date.
export function runwayAlertLevel(runwayDays) {
  if (runwayDays === null || runwayDays === undefined) return 'ok';
  const days = Number(runwayDays);
  if (!Number.isFinite(days)) return 'ok';
  if (days <= RUNWAY_ALERT_DAYS.critical) return 'critical';
  if (days <= RUNWAY_ALERT_DAYS.high) return 'high';
  if (days <= RUNWAY_ALERT_DAYS.warning) return 'warning';
  return 'ok';
}

export const BURN_WINDOW_SEC = 24 * 3600;
export const BURN_MIN_SPAN_SEC = 3600;
export const BALANCE_SAMPLE_RETENTION_SEC = 7 * 24 * 3600;
export const MAX_BALANCE_SAMPLES = 1000;

const isBalanceSample = (sample) =>
  Boolean(sample) &&
  typeof sample === 'object' &&
  Number.isFinite(sample.t) &&
  Number.isFinite(sample.gas) &&
  sample.gas >= 0;

// Pure: the sample history after one more run. Bounded in age and size, ordered, one sample per
// instant. Time going backwards means the ordering can no longer be trusted, so the history starts
// again from the new sample instead of mixing two clocks.
export function appendBalanceSample(
  samples,
  sample,
  { retentionSec = BALANCE_SAMPLE_RETENTION_SEC, maxSamples = MAX_BALANCE_SAMPLES } = {}
) {
  const history = Array.isArray(samples) ? samples.filter(isBalanceSample) : [];
  if (!isBalanceSample(sample)) return history;
  const fresh = { t: sample.t, gas: sample.gas };
  const last = history[history.length - 1];
  let next;
  if (last && fresh.t < last.t) next = [fresh];
  else if (last && fresh.t === last.t) next = [...history.slice(0, -1), fresh];
  else next = [...history, fresh];
  const oldest = fresh.t - retentionSec;
  return next.filter((entry) => entry.t >= oldest).slice(-maxSamples);
}

// Pure: the samples of a persisted history file, or [] when the file is not this monitor's own
// well-formed history for this network and updater.
export function parseBalanceHistory(raw, { network, updater } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  if (raw.version !== 1 || raw.network !== network || raw.updater !== updater) return [];
  if (!Array.isArray(raw.samples)) return [];
  const ordered = raw.samples
    .filter(isBalanceSample)
    .map((sample) => ({ t: sample.t, gas: sample.gas }))
    .sort((a, b) => a.t - b.t);
  const history = [];
  for (const sample of ordered) {
    if (history.length && history[history.length - 1].t === sample.t) {
      history[history.length - 1] = sample;
    } else {
      history.push(sample);
    }
  }
  return history;
}

// Pure: GAS burned per day over the last `windowSec`, from the samples. A balance that rises between
// two samples was topped up, so that interval says nothing about consumption and is left out of both
// the amount and the time. Less than `minSpanSec` of clean history is not an estimate.
export function computeBurnRate(
  samples,
  { windowSec = BURN_WINDOW_SEC, minSpanSec = BURN_MIN_SPAN_SEC } = {}
) {
  const list = Array.isArray(samples) ? samples.filter(isBalanceSample) : [];
  const unknown = { burn_gas_per_day: null, span_sec: 0, consumed_gas: 0, intervals: 0 };
  if (list.length < 2) return unknown;
  const start = list[list.length - 1].t - windowSec;
  let consumed = 0;
  let span = 0;
  let intervals = 0;
  for (let index = 1; index < list.length; index += 1) {
    const from = list[index - 1];
    const to = list[index];
    const seconds = to.t - from.t;
    if (from.t < start || seconds <= 0 || to.gas > from.gas) continue;
    consumed += from.gas - to.gas;
    span += seconds;
    intervals += 1;
  }
  if (!intervals || span < minSpanSec) {
    return { ...unknown, span_sec: span, consumed_gas: consumed, intervals };
  }
  return {
    burn_gas_per_day: (consumed / span) * 86400,
    span_sec: span,
    consumed_gas: consumed,
    intervals,
  };
}

// Pure: how long the updater can keep writing. A balance below one write's fee cannot write at all,
// whatever the history says. Otherwise runway = balance / observed burn; with no burn or no history
// the runway is unknown (null) and the basis says which, so "no data" is never reported as "fine".
export function assessRunway({
  balanceGas,
  samples = [],
  feePerWriteGas = FEE_PER_WRITE_GAS,
  windowSec = BURN_WINDOW_SEC,
  minSpanSec = BURN_MIN_SPAN_SEC,
} = {}) {
  const burn = computeBurnRate(samples, { windowSec, minSpanSec });
  const burnPerDay = burn.burn_gas_per_day;
  let runwayDays;
  let basis;
  if (balanceGas < feePerWriteGas) {
    runwayDays = 0;
    basis = 'balance_below_write_fee';
  } else if (burnPerDay === null) {
    runwayDays = null;
    basis = 'insufficient_history';
  } else if (burnPerDay === 0) {
    runwayDays = null;
    basis = 'no_burn_observed';
  } else {
    runwayDays = balanceGas / burnPerDay;
    basis = 'observed_burn';
  }
  return {
    balance_gas: balanceGas,
    write_fee_gas: feePerWriteGas,
    burn_gas_per_day: burnPerDay,
    writes_per_day: burnPerDay === null ? null : burnPerDay / feePerWriteGas,
    burn_window_hours: burnPerDay === null ? null : burn.span_sec / 3600,
    balance_samples: Array.isArray(samples) ? samples.length : 0,
    runway_days: runwayDays,
    runway_basis: basis,
    alert_level: runwayAlertLevel(runwayDays),
  };
}

// Pure: seconds since the freshest active record was written. Retired pairs have no writer and a
// record ahead of the chain is not a real write time.
export function lastWriteAge(rows) {
  let youngest = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.clock_skew || isRetiredPair(row.pair) || !Number.isFinite(row.age)) continue;
    const age = Math.max(0, row.age);
    if (youngest === null || age < youngest) youngest = age;
  }
  return youngest;
}

// What the writer records as provider_category (classifyTwelveDataFailure in feed-pusher.mjs) and
// which of those must page. An unauthorized key, an expired plan and an exhausted quota will not fix
// themselves; a per-minute limit, a provider hiccup or an empty answer usually do, and if one does
// not the feed goes stale and the stale alert pages.
const PROVIDER_FAILURES = Object.freeze({
  provider_unauthorized: { kind: 'unauthorized', page: true },
  subscription_expired: { kind: 'expired', page: true },
  daily_quota_exhausted: { kind: 'quota', page: true },
  rate_limited: { kind: 'quota', page: true },
  minute_rate_limited: { kind: 'rate_limited', page: false },
  provider_error: { kind: 'error', page: false },
  no_usable_prices: { kind: 'no_prices', page: false },
});

export function classifyProviderFailure(category) {
  if (typeof category !== 'string' || !Object.hasOwn(PROVIDER_FAILURES, category)) return null;
  const { kind, page } = PROVIDER_FAILURES[category];
  return { category, kind, page };
}

function scrubProviderSummary(value) {
  return String(value ?? '')
    .replace(/([?&]apikey=)[^&\s]+/gi, '$1<redacted>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

const WRITER_REPORT_FUTURE_TOLERANCE_SEC = 300;

// Pure: the provider failure the writer reported in its last cycle, if that report is current.
// `status` is the writer's status document; a report older than `maxAgeSec` (or from the future, or
// without a timestamp) is not current news. Provider text is shortened and key-scrubbed.
export function assessProviderFailure(status, { nowMs = Date.now(), maxAgeSec = MAX_AGE } = {}) {
  if (!status || typeof status !== 'object' || Array.isArray(status)) return null;
  if (!Array.isArray(status.errors)) return null;
  const reportedMs = typeof status.ts === 'string' ? Date.parse(status.ts) : Number.NaN;
  if (!Number.isFinite(reportedMs)) return null;
  const ageSeconds = Math.round((nowMs - reportedMs) / 1000);
  if (ageSeconds < -WRITER_REPORT_FUTURE_TOLERANCE_SEC || ageSeconds > maxAgeSec) return null;
  for (const error of status.errors) {
    if (!error || error.code !== 'twelvedata_fetch_failed') continue;
    const classified = classifyProviderFailure(error.provider_category);
    if (!classified) continue;
    return {
      ...classified,
      reported_at: new Date(reportedMs).toISOString(),
      age_seconds: Math.max(0, ageSeconds),
      summary: scrubProviderSummary(error.summary),
    };
  }
  return null;
}

function readJsonIfPresent(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readBalanceHistory() {
  if (!existsSync(BALANCE_HISTORY)) return [];
  const raw = readJsonIfPresent(BALANCE_HISTORY);
  if (raw === null) log('balance history unreadable; starting a new one');
  return parseBalanceHistory(raw, { network: FEED_TARGET.network, updater: UPDATER });
}

// Atomic (temp + rename). Failing to remember a sample must never hide an alert.
function writeBalanceHistory(samples) {
  try {
    const tmp = `${BALANCE_HISTORY}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({ version: 1, network: FEED_TARGET.network, updater: UPDATER, samples })
    );
    renameSync(tmp, BALANCE_HISTORY);
  } catch (e) {
    log('balance history write failed: ' + (e.message || e));
  }
}

const roundTo = (value, places) =>
  value === null || value === undefined ? null : Math.round(value * 10 ** places) / 10 ** places;

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
        alert_level: 'critical',
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
    const stalePairs = [];
    for (const r of rows) {
      // A retired pair has no writer, so its age is expected, not a fault.
      if (isRetiredPair(r.pair)) continue;
      if (r.clock_skew) {
        problems.push(`CLOCK SKEW ${r.pair} ahead=${Math.abs(r.age)}s`);
        continue;
      }
      const limit = staleAgeLimit(r.pair, date);
      if (r.age > limit) {
        stalePairs.push(r.pair);
        problems.push(`FEED STALE ${r.pair} age=${(r.age / 60).toFixed(0)}min`);
      }
    }
    const g = await rpc('invokefunction', [
      GASH,
      'balanceOf',
      [{ type: 'Hash160', value: UPDATER }],
    ]);
    const gas = Number(g.stack[0].value) / 1e8;
    if (gas < MIN_GAS) problems.push(`LOW GAS updater=${gas.toFixed(1)} (refund ${UPDATER})`);
    // Runway: days of writes the balance still pays for at the burn of the last day (CU-11).
    const samples = appendBalanceSample(readBalanceHistory(), { t: now, gas });
    writeBalanceHistory(samples);
    const runway = assessRunway({ balanceGas: gas, samples });
    if (runway.runway_basis === 'balance_below_write_fee') {
      problems.push(
        `UPDATER CANNOT PAY A WRITE balance=${gas.toFixed(8)} GAS < ${FEE_PER_WRITE_GAS} GAS fee per write (refund ${UPDATER})`
      );
    } else if (runway.alert_level !== 'ok') {
      problems.push(
        `RUNWAY ${runway.alert_level.toUpperCase()} ${runway.runway_days.toFixed(1)}d left ` +
          `(balance ${gas.toFixed(4)} GAS, burn ${runway.burn_gas_per_day.toFixed(3)} GAS/day = ` +
          `${runway.writes_per_day.toFixed(0)} writes/day at ${FEE_PER_WRITE_GAS} GAS each; refund ${UPDATER})`
      );
    }
    // A provider failure the writer reported in its last cycle: an unauthorized key, an expired plan
    // or an exhausted quota does not heal by itself, so it pages instead of waiting for staleness.
    const providerFailure = assessProviderFailure(readJsonIfPresent(WRITER_STATUS), {
      nowMs: Date.now(),
      maxAgeSec: MAX_AGE,
    });
    if (providerFailure && providerFailure.page) {
      problems.push(
        `PROVIDER FAILURE ${providerFailure.kind} (${providerFailure.category}) reported ` +
          `${providerFailure.age_seconds}s ago by the writer: ${providerFailure.summary}`
      );
    }
    const alertLevel = maxAlertLevel([
      stalePairs.length ? 'critical' : 'ok',
      clockSkewRows.length ? 'critical' : 'ok',
      gas < MIN_GAS ? 'high' : 'ok',
      runway.alert_level,
      providerFailure && providerFailure.page ? 'critical' : 'ok',
    ]);
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
          // Machine-readable health for whatever consumes this file (CU-11). alert_level is the
          // worst of: a stale pair, clock skew, a paging provider failure and a runway of 3 days or
          // less (critical); a runway of 7 days or less or a balance under MIN_GAS (high); a runway
          // of 14 days or less (warning). last_write_age is in seconds; runway_days is null when it
          // cannot be estimated (see runway_basis), and 0 when the balance cannot pay one write.
          alert_level: alertLevel,
          runway_days: roundTo(runway.runway_days, 4),
          runway_basis: runway.runway_basis,
          burn_gas_per_day: roundTo(runway.burn_gas_per_day, 6),
          writes_per_day: roundTo(runway.writes_per_day, 3),
          write_fee_gas: runway.write_fee_gas,
          burn_window_hours: roundTo(runway.burn_window_hours, 2),
          balance_samples: runway.balance_samples,
          last_write_age: lastWriteAge(rows),
          stale_pairs: stalePairs,
          provider_failure: providerFailure,
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
