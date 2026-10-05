import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { FEED_NETWORK_DEFAULTS, finalizePusherCycle } from './lib-feed-network.mjs';

const MONITOR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'feed-monitor.mjs');

process.env.FEED_MONITOR_SKIP_MAIN = '1';
const {
  parseAllRecords,
  isMarketClosed,
  staleAgeLimit,
  renderPromText,
  OBSERVED_FEE_PER_WRITE_GAS,
  ALERT_LEVELS,
  maxAlertLevel,
  runwayAlertLevel,
  appendBalanceSample,
  parseBalanceHistory,
  computeBurnRate,
  assessRunway,
  classifyProviderFailure,
  assessProviderFailure,
  lastWriteAge,
} = await import('./feed-monitor.mjs');

function recordStruct(pair, { roundId = 1, price = 5_250_000, timestamp }) {
  return {
    type: 'Struct',
    value: [
      { type: 'ByteString', value: Buffer.from(pair).toString('base64') },
      { type: 'Integer', value: String(roundId) },
      { type: 'Integer', value: String(price) },
      { type: 'Integer', value: String(timestamp) },
      { type: 'ByteString', value: '' },
      { type: 'Integer', value: '0' },
    ],
  };
}

// Mock RPC that serves the batched getAllFeedRecords (the new per-pair path) and
// the updater GAS balance. `records` = array of { pair, timestamp, ... }.
function startMockAllRecordsRpc({ records, gasBalance, magic = 860833102, headerTime = null }) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const body = JSON.parse(raw);
        if (body.method === 'getversion') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              result: { protocol: { network: magic } },
            })
          );
          return;
        }
        if (body.method === 'getblockcount') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: 100 }));
          return;
        }
        if (body.method === 'getblock') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              result: { time: headerTime ?? Math.floor(Date.now() / 1000) },
            })
          );
          return;
        }
        const operation = body.params && body.params[1];
        let result;
        if (operation === 'getAllFeedRecords') {
          result = {
            state: 'HALT',
            stack: [{ type: 'Array', value: records.map((r) => recordStruct(r.pair, r)) }],
          };
        } else if (operation === 'getLatest') {
          const neo = records.find((r) => r.pair === 'TWELVEDATA:NEO-USD') || records[0];
          result = { state: 'HALT', stack: [recordStruct(neo.pair, neo)] };
        } else {
          result = { state: 'HALT', stack: [{ type: 'Integer', value: String(gasBalance) }] };
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function feedRecordStruct({ roundId, price, timestamp }) {
  return {
    type: 'Struct',
    value: [
      { type: 'ByteString', value: Buffer.from('TWELVEDATA:NEO-USD').toString('base64') },
      { type: 'Integer', value: String(roundId) },
      { type: 'Integer', value: String(price) },
      { type: 'Integer', value: String(timestamp) },
      { type: 'ByteString', value: '' },
      { type: 'Integer', value: '0' },
    ],
  };
}

function startMockRpc({
  roundId,
  timestamp,
  gasBalance,
  magic = 860833102,
  allRecords = 'neo',
  headerTime = null,
}) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const body = JSON.parse(raw);
        if (body.method === 'getversion') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              result: { protocol: { network: magic } },
            })
          );
          return;
        }
        if (body.method === 'getblockcount') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: 100 }));
          return;
        }
        if (body.method === 'getblock') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              result: { time: headerTime ?? Math.floor(Date.now() / 1000) },
            })
          );
          return;
        }
        const operation = body.params && body.params[1];
        let result;
        if (operation === 'getAllFeedRecords') {
          if (allRecords === 'fault') result = { state: 'FAULT', exception: 'bad' };
          else if (allRecords === 'empty')
            result = { state: 'HALT', stack: [{ type: 'Array', value: [] }] };
          else if (allRecords === 'malformed')
            result = { state: 'HALT', stack: [{ type: 'Integer', value: '1' }] };
          else if (allRecords === 'partial')
            result = {
              state: 'HALT',
              stack: [
                {
                  type: 'Array',
                  value: [
                    feedRecordStruct({ roundId, price: 5_250_000, timestamp }),
                    { type: 'Struct', value: [{ type: 'ByteString', value: '' }] },
                  ],
                },
              ],
            };
          else
            result = {
              state: 'HALT',
              stack: [
                {
                  type: 'Array',
                  value: [feedRecordStruct({ roundId, price: 5_250_000, timestamp })],
                },
              ],
            };
        } else if (operation === 'getLatest') {
          result = {
            state: 'HALT',
            stack: [feedRecordStruct({ roundId, price: 5_250_000, timestamp })],
          };
        } else {
          result = { state: 'HALT', stack: [{ type: 'Integer', value: String(gasBalance) }] };
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function runMonitor(rpcUrl, statusFile, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MONITOR], {
      env: {
        ...process.env,
        FEED_RPCS: rpcUrl,
        MONITOR_LOG: path.join(path.dirname(statusFile), 'feed-monitor.log'),
        MONITOR_STATUS: statusFile,
        FEED_MONITOR_SKIP_MAIN: '',
        ...extraEnv,
      },
      encoding: 'utf8',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('monitor measures age from the Timestamp field, not RoundId', async () => {
  const now = Math.floor(Date.now() / 1000);
  // A counter-style roundId (42) with a fresh timestamp must NOT alert: the
  // FeedRecord struct is [Pair, RoundId, Price, Timestamp, ...], and only the
  // current pusher happens to write roundId ≈ unix time.
  const server = await startMockRpc({ roundId: 42, timestamp: now - 60, gasBalance: 100e8 });
  const { port } = server.address();
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'feed-monitor-'));
  const statusFile = path.join(tmp, 'feed-status.json');
  try {
    const result = await runMonitor(`http://127.0.0.1:${port}`, statusFile);
    assert.equal(
      result.code,
      0,
      `expected ok exit, got ${result.code}: ${result.stdout}${result.stderr}`
    );
    assert.match(result.stdout, /feed_age=1min/);
    const status = JSON.parse(readFileSync(statusFile, 'utf8'));
    assert.equal(status.ok, true);
    assert.equal(status.feed_age_min, 1);
  } finally {
    server.close();
  }
});

test('monitor alerts on a genuinely stale timestamp even when roundId looks fresh', async () => {
  const now = Math.floor(Date.now() / 1000);
  const server = await startMockRpc({
    roundId: now,
    timestamp: now - 10 * 86400,
    gasBalance: 100e8,
  });
  const { port } = server.address();
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'feed-monitor-'));
  const statusFile = path.join(tmp, 'feed-status.json');
  try {
    const result = await runMonitor(`http://127.0.0.1:${port}`, statusFile);
    assert.equal(
      result.code,
      1,
      `expected stale alert exit 1, got ${result.code}: ${result.stdout}${result.stderr}`
    );
    assert.match(result.stdout, /FEED STALE NEO-USD/);
    const status = JSON.parse(readFileSync(statusFile, 'utf8'));
    assert.equal(status.ok, false);
  } finally {
    server.close();
  }
});

test('monitor alerts on a low updater GAS balance', async () => {
  const now = Math.floor(Date.now() / 1000);
  const server = await startMockRpc({ roundId: 42, timestamp: now - 60, gasBalance: 2e8 });
  const { port } = server.address();
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'feed-monitor-'));
  const statusFile = path.join(tmp, 'feed-status.json');
  try {
    const result = await runMonitor(`http://127.0.0.1:${port}`, statusFile);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /LOW GAS updater=2\.0/);
  } finally {
    server.close();
  }
});

// ── F6: per-pair staleness ────────────────────────────────────────────────────

test('parseAllRecords strips the TWELVEDATA: prefix and computes per-pair age', () => {
  const now = 1_780_000_000;
  const decoded = parseAllRecords(
    {
      state: 'HALT',
      stack: [
        {
          type: 'Array',
          value: [
            recordStruct('TWELVEDATA:NEO-USD', { timestamp: now - 120 }),
            recordStruct('TWELVEDATA:BTC-USD', { timestamp: now - 300 }),
          ],
        },
      ],
    },
    now
  );
  assert.equal(decoded.ok, true);
  assert.deepEqual(decoded.rows, [
    { pair: 'NEO-USD', ts: now - 120, age: 120, clock_skew: false },
    { pair: 'BTC-USD', ts: now - 300, age: 300, clock_skew: false },
  ]);
  const future = parseAllRecords(
    {
      state: 'HALT',
      stack: [
        {
          type: 'Array',
          value: [recordStruct('TWELVEDATA:NEO-USD', { timestamp: now + 200 })],
        },
      ],
    },
    now
  );
  assert.equal(future.rows[0].clock_skew, true);
  assert.equal(future.rows[0].age, -200);
  assert.equal(parseAllRecords({ state: 'FAULT', stack: [] }, now).reason, 'fault');
  assert.equal(parseAllRecords(null, now).ok, false);
  assert.equal(
    parseAllRecords({ state: 'HALT', stack: [{ type: 'Array', value: [] }] }, now).reason,
    'empty'
  );
});

test('isMarketClosed flags weekends and configured holidays only', () => {
  // 2026-06-13 = Sat, 2026-06-14 = Sun, 2026-06-15 = Mon.
  assert.equal(isMarketClosed(new Date('2026-06-13T12:00:00Z')), true);
  assert.equal(isMarketClosed(new Date('2026-06-14T12:00:00Z')), true);
  assert.equal(isMarketClosed(new Date('2026-06-15T12:00:00Z')), false);
  // A mid-week date is open by default, closed only when listed as a holiday.
  const thu = new Date('2026-12-24T12:00:00Z'); // Thursday, not a weekend
  assert.equal(isMarketClosed(thu), false);
  assert.equal(isMarketClosed(thu, { tradfiHolidays: new Set(['2026-12-24']) }), true);
});

test('staleAgeLimit widens the window for TradFi pairs only while the market is closed', () => {
  const opts = {
    maxAge: 2700,
    tradfiPairs: new Set(['EUR-USD', 'WTI-USD']),
    tradfiWeekendAge: 270000,
    tradfiHolidays: new Set(),
  };
  const weekend = new Date('2026-06-14T12:00:00Z'); // Sunday
  const weekday = new Date('2026-06-15T12:00:00Z'); // Monday
  // TradFi pair over the weekend gets the widened window.
  assert.equal(staleAgeLimit('EUR-USD', weekend, opts), 270000);
  // Same pair on a weekday keeps the normal window.
  assert.equal(staleAgeLimit('EUR-USD', weekday, opts), 2700);
  // Crypto pair never widens (trades 24/7).
  assert.equal(staleAgeLimit('NEO-USD', weekend, opts), 2700);
});

test('renderPromText emits feed_age_seconds{pair,network} for every pair plus updater gas', () => {
  const text = renderPromText(
    [
      { pair: 'NEO-USD', age: 120 },
      { pair: 'EUR-USD', age: 50000 },
    ],
    73.5,
    'neo-n3'
  );
  assert.match(text, /feed_age_seconds\{pair="NEO-USD",network="neo-n3"\} 120/);
  assert.match(text, /feed_age_seconds\{pair="EUR-USD",network="neo-n3"\} 50000/);
  assert.match(text, /feed_updater_gas\{network="neo-n3"\} 73\.5/);
  assert.match(text, /# TYPE feed_age_seconds gauge/);
});

test('monitor iterates the full registry and writes the Prometheus textfile', async () => {
  const now = Math.floor(Date.now() / 1000);
  const server = await startMockAllRecordsRpc({
    records: [
      { pair: 'TWELVEDATA:NEO-USD', timestamp: now - 60 },
      { pair: 'TWELVEDATA:BTC-USD', timestamp: now - 120 },
      { pair: 'TWELVEDATA:ETH-USD', timestamp: now - 90 },
    ],
    gasBalance: 100e8,
  });
  const { port } = server.address();
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'feed-monitor-'));
  const statusFile = path.join(tmp, 'feed-status.json');
  const promFile = path.join(tmp, 'feed.prom');
  try {
    const result = await runMonitor(`http://127.0.0.1:${port}`, statusFile, {
      MONITOR_PROM_TEXTFILE: promFile,
    });
    assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /ok pairs=3/);
    const status = JSON.parse(readFileSync(statusFile, 'utf8'));
    assert.equal(status.ok, true);
    assert.equal(status.pairs.length, 3);
    // feed_age_min back-compat (NEO-USD).
    assert.equal(status.feed_age_min, 1);
    const prom = readFileSync(promFile, 'utf8');
    for (const pair of ['NEO-USD', 'BTC-USD', 'ETH-USD'])
      assert.match(prom, new RegExp(`feed_age_seconds\\{pair="${pair}",network="neo-n3"\\}`));
    assert.match(prom, /feed_updater_gas\{network="neo-n3"\} 100/);
  } finally {
    server.close();
  }
});

// A retired pair (COPPER-USD: TwelveData's HG1 is Homag Group AG, not copper;
// 1000JPY-USD: a legacy scaled variant) has no writer, so it ages forever by
// design. Counting it as staleness makes this monitor permanently red, and a
// monitor that is always red is a monitor nobody reads — the condition that let a
// 22-day outage pass unnoticed. It must be excluded from ALERT but still reported.
test('monitor does not alert on retired pairs but still reports them', async () => {
  const now = Math.floor(Date.now() / 1000);
  const server = await startMockAllRecordsRpc({
    records: [
      { pair: 'TWELVEDATA:NEO-USD', timestamp: now - 60 },
      { pair: 'TWELVEDATA:COPPER-USD', timestamp: now - 75 * 86400 },
      { pair: 'TWELVEDATA:1000JPY-USD', timestamp: now - 162 * 86400 },
    ],
    gasBalance: 100e8,
  });
  const { port } = server.address();
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'feed-monitor-'));
  const statusFile = path.join(tmp, 'feed-status.json');
  try {
    const result = await runMonitor(`http://127.0.0.1:${port}`, statusFile);
    assert.equal(result.code, 0, 'retired pairs must not fail the monitor');
    assert.doesNotMatch(result.stdout, /FEED STALE/);
    const status = JSON.parse(readFileSync(statusFile, 'utf8'));
    assert.equal(status.ok, true);
    // Excluded from the alert, but NOT hidden: still enumerated and flagged.
    const copper = status.pairs.find((p) => p.pair === 'COPPER-USD');
    assert.ok(copper, 'retired pair must still be reported');
    assert.equal(copper.retired, true);
    assert.equal(status.pairs.find((p) => p.pair === 'NEO-USD').retired, false);
  } finally {
    server.close();
  }
});

// A pair that is NOT retired must still fail the monitor at the same age, so the
// exclusion above cannot be widened into a way of silencing a real outage.
test('FEED_NETWORK=testnet points the monitor at 0x9bea… and records it in the snapshot', async () => {
  const now = Math.floor(Date.now() / 1000);
  const server = await startMockAllRecordsRpc({
    records: [{ pair: 'TWELVEDATA:NEO-USD', timestamp: now - 60 }],
    gasBalance: 100e8,
    magic: 894710606,
  });
  const { port } = server.address();
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'feed-monitor-'));
  const statusFile = path.join(tmp, 'feed-status.json');
  try {
    const result = await runMonitor(`http://127.0.0.1:${port}`, statusFile, {
      FEED_NETWORK: 'testnet',
    });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const status = JSON.parse(readFileSync(statusFile, 'utf8'));
    assert.equal(status.network, 'testnet');
    assert.equal(status.feed, '0x9bea75cf702f6afc09125aa6d22f082bfd2ee064');
    assert.equal(status.updater, '0xe421999c396ee0249a8a8c9dd95bfbdaf55f8bf7');
  } finally {
    server.close();
  }
});

test('monitor exits 2 when getversion magic does not match the pinned network', async () => {
  const now = Math.floor(Date.now() / 1000);
  const server = await startMockAllRecordsRpc({
    records: [{ pair: 'TWELVEDATA:NEO-USD', timestamp: now - 60 }],
    gasBalance: 100e8,
    magic: 860833102,
  });
  const { port } = server.address();
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'feed-monitor-'));
  const statusFile = path.join(tmp, 'feed-status.json');
  try {
    const result = await runMonitor(`http://127.0.0.1:${port}`, statusFile, {
      FEED_NETWORK: 'testnet',
    });
    assert.equal(result.code, 2);
    assert.match(result.stdout, /no RPC matched magic|getversion|monitor RPC error/i);
  } finally {
    server.close();
  }
});

test('monitor still alerts on a stale pair that is not retired', async () => {
  const now = Math.floor(Date.now() / 1000);
  const server = await startMockAllRecordsRpc({
    records: [
      { pair: 'TWELVEDATA:NEO-USD', timestamp: now - 60 },
      { pair: 'TWELVEDATA:CORN-USD', timestamp: now - 75 * 86400 },
    ],
    gasBalance: 100e8,
  });
  const { port } = server.address();
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'feed-monitor-'));
  const statusFile = path.join(tmp, 'feed-status.json');
  try {
    const result = await runMonitor(`http://127.0.0.1:${port}`, statusFile);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /FEED STALE CORN-USD/);
  } finally {
    server.close();
  }
});

test('monitor fails closed on FAULT, empty, malformed, and partial getAllFeedRecords', async () => {
  const now = Math.floor(Date.now() / 1000);
  for (const [mode, reason] of [
    ['fault', 'fault'],
    ['empty', 'empty'],
    ['malformed', 'malformed'],
    ['partial', 'undecodable'],
  ]) {
    const server = await startMockRpc({
      roundId: 42,
      timestamp: now - 60,
      gasBalance: 100e8,
      allRecords: mode,
    });
    const { port } = server.address();
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'feed-monitor-'));
    const statusFile = path.join(tmp, 'feed-status.json');
    try {
      const result = await runMonitor(`http://127.0.0.1:${port}`, statusFile);
      assert.equal(result.code, 2, `${mode} must exit 2: ${result.stdout}${result.stderr}`);
      assert.match(result.stdout, /getAllFeedRecords/);
      const status = JSON.parse(readFileSync(statusFile, 'utf8'));
      assert.equal(status.ok, false);
      assert.equal(status.unreadable_reason, reason);
    } finally {
      server.close();
    }
  }
});

test('monitor uses chain header time so wall-clock drift cannot hide staleness', async () => {
  const header = 1_788_177_600;
  const server = await startMockAllRecordsRpc({
    records: [{ pair: 'TWELVEDATA:NEO-USD', timestamp: header - 10 * 86400 }],
    gasBalance: 100e8,
    headerTime: header * 1000,
  });
  const { port } = server.address();
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'feed-monitor-'));
  const statusFile = path.join(tmp, 'feed-status.json');
  try {
    const result = await runMonitor(`http://127.0.0.1:${port}`, statusFile);
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /FEED STALE NEO-USD/);
    const status = JSON.parse(readFileSync(statusFile, 'utf8'));
    assert.equal(status.ok, false);
    assert.ok(status.pairs[0].age_seconds >= 10 * 86400 - 5);
  } finally {
    server.close();
  }
});

test('monitor accepts a seconds-scale header time without inventing clock_skew', async () => {
  const header = 1_788_177_600;
  const server = await startMockAllRecordsRpc({
    records: [{ pair: 'TWELVEDATA:NEO-USD', timestamp: header - 60 }],
    gasBalance: 100e8,
    headerTime: header,
  });
  const { port } = server.address();
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'feed-monitor-'));
  const statusFile = path.join(tmp, 'feed-status.json');
  try {
    const result = await runMonitor(`http://127.0.0.1:${port}`, statusFile);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const status = JSON.parse(readFileSync(statusFile, 'utf8'));
    assert.equal(status.ok, true);
    assert.equal(status.clock_skew, false);
    assert.equal(status.pairs[0].clock_skew, false);
    assert.ok(status.pairs[0].age_seconds >= 55 && status.pairs[0].age_seconds <= 65);
  } finally {
    server.close();
  }
});

test('monitor accepts a milliseconds-scale header time without inventing clock_skew', async () => {
  const header = 1_788_177_600;
  const server = await startMockAllRecordsRpc({
    records: [{ pair: 'TWELVEDATA:NEO-USD', timestamp: header - 90 }],
    gasBalance: 100e8,
    headerTime: header * 1000,
  });
  const { port } = server.address();
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'feed-monitor-'));
  const statusFile = path.join(tmp, 'feed-status.json');
  try {
    const result = await runMonitor(`http://127.0.0.1:${port}`, statusFile);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const status = JSON.parse(readFileSync(statusFile, 'utf8'));
    assert.equal(status.ok, true);
    assert.equal(status.clock_skew, false);
    assert.equal(status.pairs[0].clock_skew, false);
    assert.ok(status.pairs[0].age_seconds >= 85 && status.pairs[0].age_seconds <= 95);
  } finally {
    server.close();
  }
});

test('monitor flags a pair more than 120s ahead of header time as clock_skew and exits 2', async () => {
  const header = 1_788_177_600;
  const server = await startMockAllRecordsRpc({
    records: [
      { pair: 'TWELVEDATA:NEO-USD', timestamp: header + 200 },
      { pair: 'TWELVEDATA:BTC-USD', timestamp: header - 60 },
    ],
    gasBalance: 100e8,
    headerTime: header,
  });
  const { port } = server.address();
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'feed-monitor-'));
  const statusFile = path.join(tmp, 'feed-status.json');
  try {
    const result = await runMonitor(`http://127.0.0.1:${port}`, statusFile);
    assert.equal(result.code, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /CLOCK SKEW|clock_skew/i);
    const status = JSON.parse(readFileSync(statusFile, 'utf8'));
    assert.equal(status.ok, false);
    assert.equal(status.clock_skew, true);
    const neo = status.pairs.find((row) => row.pair === 'NEO-USD');
    const btc = status.pairs.find((row) => row.pair === 'BTC-USD');
    assert.equal(neo.clock_skew, true);
    assert.equal(btc.clock_skew, false);
  } finally {
    server.close();
  }
});

test('monitor flags an individual stale pair from the full registry', async () => {
  const now = Math.floor(Date.now() / 1000);
  // BTC-USD is 10 days stale (crypto, never widened) while the others are fresh.
  const server = await startMockAllRecordsRpc({
    records: [
      { pair: 'TWELVEDATA:NEO-USD', timestamp: now - 60 },
      { pair: 'TWELVEDATA:BTC-USD', timestamp: now - 10 * 86400 },
    ],
    gasBalance: 100e8,
  });
  const { port } = server.address();
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'feed-monitor-'));
  const statusFile = path.join(tmp, 'feed-status.json');
  try {
    const result = await runMonitor(`http://127.0.0.1:${port}`, statusFile);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /FEED STALE BTC-USD/);
    assert.doesNotMatch(result.stdout, /FEED STALE NEO-USD/);
  } finally {
    server.close();
  }
});

// ── CU-11: burn-rate runway, stale and provider-failure paging, machine-readable status ──
//
// The 2026-10-01 outage: the mainnet updater burned about 4.5 GAS a day (752 transactions on
// 2026-09-30 alone, 0.00606339 GAS each), the monitor's only balance alert was a fixed 12 GAS
// floor, and the balance ran dry. These tests pin the replacement: runway in days from recent balance
// samples and the observed fee per write, alerts at 14, 7 and 3 days, paging on a stale pair
// and on a provider failure, and a machine-readable status.

const FEE = 0.00606339; // GAS per write, observed on mainnet on 2026-09-30
const OBSERVED_WRITES_PER_DAY = 752;
const OBSERVED_BURN_GAS_PER_DAY = OBSERVED_WRITES_PER_DAY * FEE; // 4.5595... GAS a day
const HEADER = 1_788_177_600; // chain header time of the CLI runs below (a Monday, crypto pairs only)
const SAMPLE_STEP_SEC = 900; // the monitor timer runs every 15 minutes
const MAINNET_UPDATER = `0x${FEED_NETWORK_DEFAULTS.mainnet.updaterSh}`;
const TESTNET_MAGIC = 894710606;

// Balance samples every `stepSec`, falling by `writesPerDay` writes' worth of fee per day,
// and ending at (endT, endGas).
function burnSeries({
  endT,
  endGas,
  writesPerDay = OBSERVED_WRITES_PER_DAY,
  hours = 24,
  stepSec = SAMPLE_STEP_SEC,
}) {
  const steps = Math.round((hours * 3600) / stepSec);
  const perStep = (writesPerDay * FEE * stepSec) / 86400;
  const samples = [];
  for (let i = 0; i <= steps; i += 1) {
    samples.push({ t: endT - (steps - i) * stepSec, gas: endGas + perStep * (steps - i) });
  }
  return samples;
}

const PER_STEP_BURN = (OBSERVED_WRITES_PER_DAY * FEE * SAMPLE_STEP_SEC) / 86400;

function seedHistory(statusFile, samples, header = {}) {
  writeFileSync(
    `${statusFile}.balance-samples.json`,
    JSON.stringify({
      version: 1,
      network: 'mainnet',
      updater: MAINNET_UPDATER,
      samples,
      ...header,
    })
  );
}

// One monitor run against a mock chain. `balanceGas` is the updater balance at header time.
async function runCu11Monitor({
  tmp,
  records = [{ pair: 'TWELVEDATA:NEO-USD', timestamp: HEADER - 60 }],
  balanceGas,
  header = HEADER,
  magic,
  env = {},
}) {
  const server = await startMockAllRecordsRpc({
    records,
    gasBalance: Math.round(balanceGas * 1e8),
    headerTime: header,
    ...(magic ? { magic } : {}),
  });
  const { port } = server.address();
  const statusFile = path.join(tmp, 'feed-status.json');
  try {
    const result = await runMonitor(`http://127.0.0.1:${port}`, statusFile, env);
    const status = JSON.parse(readFileSync(statusFile, 'utf8'));
    return { result, status, statusFile };
  } finally {
    server.close();
  }
}

function writerStatusFile(dir, name, { fetchError, ts = new Date().toISOString() }) {
  const cycle = finalizePusherCycle({ fetchError });
  writeFileSync(
    path.join(dir, name),
    JSON.stringify({ ts, network: 'mainnet', ok: cycle.ok, errors: cycle.errors })
  );
}

function providerError(category, message) {
  return Object.assign(new Error(message), { providerCategory: category });
}

test('CU-11: the fee per write is the observed 0.00606339 GAS', () => {
  assert.equal(OBSERVED_FEE_PER_WRITE_GAS, 0.00606339);
  assert.ok(Math.abs(OBSERVED_BURN_GAS_PER_DAY - 4.5595) < 0.001);
});

test('CU-11: runwayAlertLevel switches at 14, 7 and 3 days and stays quiet when the runway is long or unknown', () => {
  assert.deepEqual(ALERT_LEVELS, ['ok', 'warning', 'high', 'critical']);
  const cases = [
    [Infinity, 'ok'],
    [null, 'ok'],
    [undefined, 'ok'],
    [Number.NaN, 'ok'],
    [30, 'ok'],
    [14.0001, 'ok'],
    [14, 'warning'],
    [10, 'warning'],
    [7.0001, 'warning'],
    [7, 'high'],
    [5, 'high'],
    [3.0001, 'high'],
    [3, 'critical'],
    [1, 'critical'],
    [0, 'critical'],
    [-1, 'critical'],
  ];
  for (const [days, level] of cases) assert.equal(runwayAlertLevel(days), level, `runway ${days}`);
});

test('CU-11: maxAlertLevel is the most severe level and ignores anything unknown', () => {
  assert.equal(maxAlertLevel([]), 'ok');
  assert.equal(maxAlertLevel(['ok', 'warning']), 'warning');
  assert.equal(maxAlertLevel(['warning', 'critical', 'high']), 'critical');
  assert.equal(maxAlertLevel(['high', 'bogus', undefined]), 'high');
});

test('CU-11: computeBurnRate recovers the observed 752 writes a day from recent balance samples', () => {
  const burn = computeBurnRate(burnSeries({ endT: HEADER, endGas: 100 }));
  assert.ok(Math.abs(burn.burn_gas_per_day - OBSERVED_BURN_GAS_PER_DAY) < 1e-9);
  assert.ok(Math.abs(burn.burn_gas_per_day / OBSERVED_FEE_PER_WRITE_GAS - 752) < 1e-6);
  assert.equal(burn.intervals, 96);
  assert.equal(burn.span_sec, 24 * 3600);
});

test('CU-11: computeBurnRate skips refills, needs an hour of history, reads a flat balance as zero and uses the last 24 hours', () => {
  // A 40 GAS top-up between two samples: that interval says nothing about consumption, the slope is unchanged.
  const base = burnSeries({ endT: HEADER, endGas: 100 });
  const refilled = base.map((s, i) => (i >= 48 ? { t: s.t, gas: s.gas + 40 } : s));
  const withRefill = computeBurnRate(refilled);
  assert.ok(Math.abs(withRefill.burn_gas_per_day - OBSERVED_BURN_GAS_PER_DAY) < 1e-9);
  assert.equal(withRefill.intervals, 95);
  // An hour of clean history is enough, 45 minutes is not, and one sample or none is not history.
  assert.notEqual(
    computeBurnRate(burnSeries({ endT: HEADER, endGas: 100, hours: 1 })).burn_gas_per_day,
    null
  );
  assert.equal(
    computeBurnRate(burnSeries({ endT: HEADER, endGas: 100, hours: 0.75 })).burn_gas_per_day,
    null
  );
  assert.equal(computeBurnRate([{ t: HEADER, gas: 5 }]).burn_gas_per_day, null);
  assert.equal(computeBurnRate([]).burn_gas_per_day, null);
  assert.equal(computeBurnRate(undefined).burn_gas_per_day, null);
  // A balance that did not move over a day is a real zero, not "unknown".
  assert.equal(
    computeBurnRate(burnSeries({ endT: HEADER, endGas: 100, writesPerDay: 0 })).burn_gas_per_day,
    0
  );
  // Only the last 24 hours count: a faster burn two days ago does not leak into the estimate.
  const early = burnSeries({ endT: HEADER - 86400, endGas: 200, writesPerDay: 1500 });
  const late = burnSeries({ endT: HEADER, endGas: 150, writesPerDay: 100 });
  const recent = computeBurnRate([...early.slice(0, -1), ...late]);
  assert.ok(Math.abs(recent.burn_gas_per_day - 100 * FEE) < 1e-9);
});

test('CU-11: appendBalanceSample keeps an ordered, bounded, de-duplicated history', () => {
  let samples = [];
  samples = appendBalanceSample(samples, { t: 1000, gas: 5 });
  samples = appendBalanceSample(samples, { t: 1900, gas: 4.9 });
  assert.deepEqual(samples, [
    { t: 1000, gas: 5 },
    { t: 1900, gas: 4.9 },
  ]);
  // The same instant replaces the sample instead of duplicating it.
  samples = appendBalanceSample(samples, { t: 1900, gas: 4.8 });
  assert.deepEqual(samples.at(-1), { t: 1900, gas: 4.8 });
  assert.equal(samples.length, 2);
  // Time going backwards means the history cannot be trusted: start again from the new sample.
  assert.deepEqual(appendBalanceSample(samples, { t: 1500, gas: 4.7 }), [{ t: 1500, gas: 4.7 }]);
  // Invalid samples change nothing.
  for (const bad of [
    { t: Number.NaN, gas: 1 },
    { t: 2000, gas: -1 },
    { t: 2000, gas: Number.NaN },
    { t: 'x', gas: 1 },
    null,
  ]) {
    assert.deepEqual(appendBalanceSample(samples, bad), samples);
  }
  // Retention and size bounds.
  assert.deepEqual(
    appendBalanceSample(
      [
        { t: 0, gas: 9 },
        { t: 600, gas: 8 },
      ],
      { t: 1000, gas: 7 },
      { retentionSec: 500 }
    ),
    [
      { t: 600, gas: 8 },
      { t: 1000, gas: 7 },
    ]
  );
  let bounded = [];
  for (let i = 0; i < 10; i += 1) {
    bounded = appendBalanceSample(bounded, { t: 1000 + i, gas: 10 - i }, { maxSamples: 4 });
  }
  assert.deepEqual(
    bounded.map((s) => s.t),
    [1006, 1007, 1008, 1009]
  );
});

test('CU-11: parseBalanceHistory accepts only its own well-formed history', () => {
  const target = { network: 'mainnet', updater: MAINNET_UPDATER };
  const good = {
    version: 1,
    ...target,
    samples: [
      { t: 1, gas: 2 },
      { t: 2, gas: 1.5 },
    ],
  };
  assert.deepEqual(parseBalanceHistory(good, target), good.samples);
  for (const wrong of [
    { ...good, network: 'testnet' },
    { ...good, updater: '0x0000000000000000000000000000000000000001' },
    { ...good, version: 2 },
    { ...good, samples: 'nope' },
    null,
    'garbage',
    [],
  ]) {
    assert.deepEqual(parseBalanceHistory(wrong, target), []);
  }
  // Bad entries are dropped, order is repaired, and the last of two samples at one instant wins.
  const messy = {
    ...good,
    samples: [
      { t: 3, gas: 1 },
      { t: 1, gas: 3 },
      { t: 'x', gas: 1 },
      { t: 2, gas: -1 },
      null,
      { t: 2, gas: 2 },
      { t: 2, gas: 2.5 },
    ],
  };
  assert.deepEqual(parseBalanceHistory(messy, target), [
    { t: 1, gas: 3 },
    { t: 2, gas: 2.5 },
    { t: 3, gas: 1 },
  ]);
});

test('CU-11: 0.00044659 GAS with a history of 752 writes a day is a critical alert', () => {
  const samples = burnSeries({ endT: HEADER, endGas: 0.00044659 });
  const runway = assessRunway({ balanceGas: 0.00044659, samples });
  assert.equal(runway.alert_level, 'critical');
  assert.equal(runway.runway_days, 0);
  assert.equal(runway.runway_basis, 'balance_below_write_fee');
  assert.ok(Math.abs(runway.writes_per_day - 752) < 1e-6);
  assert.ok(Math.abs(runway.burn_gas_per_day - OBSERVED_BURN_GAS_PER_DAY) < 1e-9);
  // The balance cannot pay even one write (0.00606339 GAS): critical with no history at all.
  const cold = assessRunway({ balanceGas: 0.00044659, samples: [] });
  assert.equal(cold.alert_level, 'critical');
  assert.equal(cold.runway_days, 0);
  assert.equal(cold.burn_gas_per_day, null);
});

test('CU-11: a 30-day balance at the observed burn raises no alert', () => {
  const balance = 30 * OBSERVED_BURN_GAS_PER_DAY;
  const runway = assessRunway({
    balanceGas: balance,
    samples: burnSeries({ endT: HEADER, endGas: balance }),
  });
  assert.equal(runway.alert_level, 'ok');
  assert.equal(runway.runway_basis, 'observed_burn');
  assert.ok(Math.abs(runway.runway_days - 30) < 1e-6);
});

test('CU-11: assessRunway switches levels at 14, 7 and 3 days of runway', () => {
  const cases = [
    [15, 'ok'],
    [14.2, 'ok'],
    [13.8, 'warning'],
    [7.2, 'warning'],
    [6.8, 'high'],
    [3.2, 'high'],
    [2.8, 'critical'],
    [0.5, 'critical'],
  ];
  for (const [days, level] of cases) {
    const balance = days * OBSERVED_BURN_GAS_PER_DAY;
    const runway = assessRunway({
      balanceGas: balance,
      samples: burnSeries({ endT: HEADER, endGas: balance }),
    });
    assert.equal(runway.alert_level, level, `${days} days of runway`);
    assert.ok(Math.abs(runway.runway_days - days) < 1e-6, `${days} days of runway`);
  }
});

test('CU-11: assessRunway says unknown, not fine, without history and no burn when the balance is flat', () => {
  const unknown = assessRunway({ balanceGas: 50, samples: [] });
  assert.equal(unknown.runway_basis, 'insufficient_history');
  assert.equal(unknown.runway_days, null);
  assert.equal(unknown.burn_gas_per_day, null);
  assert.equal(unknown.alert_level, 'ok');
  const flat = assessRunway({
    balanceGas: 50,
    samples: burnSeries({ endT: HEADER, endGas: 50, writesPerDay: 0 }),
  });
  assert.equal(flat.runway_basis, 'no_burn_observed');
  assert.equal(flat.runway_days, null);
  assert.equal(flat.burn_gas_per_day, 0);
  assert.equal(flat.alert_level, 'ok');
});

test('CU-11: lastWriteAge is the age of the freshest active record', () => {
  assert.equal(
    lastWriteAge([
      { pair: 'NEO-USD', age: 120, clock_skew: false },
      { pair: 'BTC-USD', age: 60, clock_skew: false },
      { pair: 'COPPER-USD', age: 5, clock_skew: false }, // retired: nothing writes it
      { pair: 'ETH-USD', age: -500, clock_skew: true }, // ahead of the chain: not a real write time
    ]),
    60
  );
  assert.equal(lastWriteAge([]), null);
  assert.equal(lastWriteAge([{ pair: 'COPPER-USD', age: 5, clock_skew: false }]), null);
});

test('CU-11: replaying the observed burn raises the first alert about 14 days before the balance reaches zero', () => {
  const startGas = 100;
  const t0 = HEADER;
  let samples = [];
  const first = {};
  for (let i = 0; ; i += 1) {
    const t = t0 + i * SAMPLE_STEP_SEC;
    const gas = startGas - PER_STEP_BURN * i;
    if (gas <= 0) break;
    samples = appendBalanceSample(samples, { t, gas });
    const level = assessRunway({ balanceGas: gas, samples }).alert_level;
    if (level !== 'ok' && !(level in first)) first[level] = { t, gas };
  }
  const zeroAt = t0 + (startGas / PER_STEP_BURN) * SAMPLE_STEP_SEC;
  const daysBeforeZero = (level) => (zeroAt - first[level].t) / 86400;
  assert.deepEqual(Object.keys(first), ['warning', 'high', 'critical']);
  assert.ok(first.warning.t < first.high.t && first.high.t < first.critical.t);
  assert.ok(
    daysBeforeZero('warning') > 13.5 && daysBeforeZero('warning') <= 14.001,
    `first alert ${daysBeforeZero('warning')} days before zero`
  );
  assert.ok(daysBeforeZero('high') > 6.5 && daysBeforeZero('high') <= 7.001);
  assert.ok(daysBeforeZero('critical') > 2.5 && daysBeforeZero('critical') <= 3.001);
  // At the first alert the updater still holds 14 days of burn, nowhere near empty.
  assert.ok(first.warning.gas > 13.9 * OBSERVED_BURN_GAS_PER_DAY);
});

test('CU-11: classifyProviderFailure pages on an unauthorized key, an expired plan and an exhausted quota', () => {
  for (const [category, kind] of [
    ['provider_unauthorized', 'unauthorized'],
    ['subscription_expired', 'expired'],
    ['daily_quota_exhausted', 'quota'],
    ['rate_limited', 'quota'],
  ]) {
    assert.deepEqual(classifyProviderFailure(category), { category, kind, page: true });
  }
  // Transient provider trouble is reported but does not page by itself: a persistent one makes the feed stale.
  for (const [category, kind] of [
    ['minute_rate_limited', 'rate_limited'],
    ['provider_error', 'error'],
    ['no_usable_prices', 'no_prices'],
  ]) {
    assert.deepEqual(classifyProviderFailure(category), { category, kind, page: false });
  }
  assert.equal(classifyProviderFailure('something_else'), null);
  assert.equal(classifyProviderFailure(undefined), null);
});

test('CU-11: a TwelveData 401 reported by the writer is classified as a provider failure that pages', () => {
  const nowMs = Date.parse('2026-10-05T12:00:00.000Z');
  const fetchError = providerError(
    'provider_unauthorized',
    'TwelveData upstream error (HTTP 401, code 401): Your API key is invalid'
  );
  const status = {
    ts: '2026-10-05T11:58:00.000Z',
    ok: false,
    errors: finalizePusherCycle({ fetchError }).errors,
  };
  const failure = assessProviderFailure(status, { nowMs, maxAgeSec: 2700 });
  assert.equal(failure.category, 'provider_unauthorized');
  assert.equal(failure.kind, 'unauthorized');
  assert.equal(failure.page, true);
  assert.equal(failure.age_seconds, 120);
  assert.equal(failure.reported_at, '2026-10-05T11:58:00.000Z');
  assert.match(failure.summary, /HTTP 401/);
  // A report older than the staleness window is not current news (the feed's own age takes over).
  assert.equal(
    assessProviderFailure(
      { ...status, ts: '2026-10-05T10:00:00.000Z' },
      { nowMs, maxAgeSec: 2700 }
    ),
    null
  );
  // A report from the future, a missing timestamp, a clean cycle and other error codes are not failures.
  assert.equal(
    assessProviderFailure(
      { ...status, ts: '2026-10-05T12:30:00.000Z' },
      { nowMs, maxAgeSec: 2700 }
    ),
    null
  );
  assert.equal(
    assessProviderFailure({ ...status, ts: undefined }, { nowMs, maxAgeSec: 2700 }),
    null
  );
  assert.equal(
    assessProviderFailure({ ts: status.ts, ok: true, errors: [] }, { nowMs, maxAgeSec: 2700 }),
    null
  );
  assert.equal(
    assessProviderFailure(
      {
        ts: status.ts,
        errors: [{ code: 'chain_push_failed', provider_category: 'provider_unauthorized' }],
      },
      { nowMs, maxAgeSec: 2700 }
    ),
    null
  );
  for (const bad of [null, undefined, 'x', 7, [], { errors: 'no' }]) {
    assert.equal(assessProviderFailure(bad, { nowMs, maxAgeSec: 2700 }), null);
  }
  // A key that leaked into a summary is never repeated by the monitor.
  const leaky = assessProviderFailure(
    {
      ts: status.ts,
      errors: [
        {
          code: 'twelvedata_fetch_failed',
          provider_category: 'provider_unauthorized',
          summary:
            'failed at https://api.twelvedata.com/price?symbol=NEO/USD&apikey=SECRET123 and Bearer TOKEN456 now',
        },
      ],
    },
    { nowMs, maxAgeSec: 2700 }
  );
  assert.doesNotMatch(leaky.summary, /SECRET123|TOKEN456/);
});

test('CU-11: the monitor pages with a critical machine-readable status when the balance cannot pay a write', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'feed-monitor-'));
  const statusFile = path.join(tmp, 'feed-status.json');
  seedHistory(
    statusFile,
    burnSeries({ endT: HEADER - SAMPLE_STEP_SEC, endGas: 0.00044659 + PER_STEP_BURN })
  );
  const { result, status } = await runCu11Monitor({ tmp, balanceGas: 0.00044659 });
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /ALERT: .*CANNOT PAY A WRITE/);
  assert.equal(status.alert_level, 'critical');
  assert.equal(status.runway_days, 0);
  assert.equal(status.runway_basis, 'balance_below_write_fee');
  assert.ok(Math.abs(status.burn_gas_per_day - OBSERVED_BURN_GAS_PER_DAY) < 0.0001);
  assert.ok(Math.abs(status.writes_per_day - 752) < 0.1);
  assert.equal(status.write_fee_gas, 0.00606339);
  assert.equal(status.last_write_age, 60);
  assert.equal(status.ok, false);
  assert.ok(status.problems.some((problem) => /CANNOT PAY A WRITE/.test(problem)));
});

test('CU-11: a 30-day balance raises no alert, exits 0 and still reports the runway', async () => {
  const balance = 30 * OBSERVED_BURN_GAS_PER_DAY;
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'feed-monitor-'));
  const statusFile = path.join(tmp, 'feed-status.json');
  seedHistory(
    statusFile,
    burnSeries({ endT: HEADER - SAMPLE_STEP_SEC, endGas: balance + PER_STEP_BURN })
  );
  const { result, status } = await runCu11Monitor({ tmp, balanceGas: balance });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(status.ok, true);
  assert.deepEqual(status.problems, []);
  assert.equal(status.alert_level, 'ok');
  assert.equal(status.runway_basis, 'observed_burn');
  assert.ok(Math.abs(status.runway_days - 30) < 0.01, `runway_days ${status.runway_days}`);
  assert.ok(Math.abs(status.burn_gas_per_day - OBSERVED_BURN_GAS_PER_DAY) < 0.0001);
  assert.equal(status.last_write_age, 60);
});

test('CU-11: the monitor switches alert levels at 14, 7 and 3 days of runway and pages on every one of them', async () => {
  for (const [days, level, code] of [
    [15, 'ok', 0],
    [13, 'warning', 1],
    [8, 'warning', 1],
    [6, 'high', 1],
    [4, 'high', 1],
    [2, 'critical', 1],
  ]) {
    const balance = days * OBSERVED_BURN_GAS_PER_DAY;
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'feed-monitor-'));
    seedHistory(
      path.join(tmp, 'feed-status.json'),
      burnSeries({ endT: HEADER - SAMPLE_STEP_SEC, endGas: balance + PER_STEP_BURN })
    );
    // MIN_GAS=0 switches the fixed floor off so only the runway decides.
    const { result, status } = await runCu11Monitor({
      tmp,
      balanceGas: balance,
      env: { MIN_GAS: '0' },
    });
    assert.equal(result.code, code, `${days} days: ${result.stdout}${result.stderr}`);
    assert.equal(status.alert_level, level, `${days} days of runway`);
    assert.ok(Math.abs(status.runway_days - days) < 0.01, `${days} days: ${status.runway_days}`);
    if (level === 'ok') {
      assert.deepEqual(status.problems, []);
    } else {
      assert.equal(status.ok, false);
      const line = status.problems.find((problem) => /^RUNWAY /.test(problem));
      assert.match(line, new RegExp(`^RUNWAY ${level.toUpperCase()} `));
      assert.match(line, /GAS\/day/);
      assert.match(result.stdout, /ALERT: .*RUNWAY /);
    }
  }
});

test('CU-11: FEED_WRITE_FEE_GAS sets the fee of one write for the cannot-pay rule (the runbook drill), and an unusable value falls back', async () => {
  const balance = 30 * OBSERVED_BURN_GAS_PER_DAY;
  const withFee = async (value) => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'feed-monitor-'));
    seedHistory(
      path.join(tmp, 'feed-status.json'),
      burnSeries({ endT: HEADER - SAMPLE_STEP_SEC, endGas: balance + PER_STEP_BURN })
    );
    return runCu11Monitor({ tmp, balanceGas: balance, env: { FEED_WRITE_FEE_GAS: value } });
  };
  // A fee larger than the balance makes the monitor fire on a perfectly healthy balance: the drill.
  const drill = await withFee('1000000');
  assert.equal(drill.result.code, 1, drill.result.stdout + drill.result.stderr);
  assert.equal(drill.status.alert_level, 'critical');
  assert.equal(drill.status.runway_basis, 'balance_below_write_fee');
  assert.equal(drill.status.write_fee_gas, 1_000_000);
  assert.ok(drill.status.problems.some((problem) => /CANNOT PAY A WRITE/.test(problem)));
  // The same chain with the fee removed, or set to nonsense, is the healthy 30 days again.
  for (const unusable of ['', 'abc', '0', '-1', 'Infinity']) {
    const run = await withFee(unusable);
    assert.equal(run.result.code, 0, `${unusable}: ${run.result.stdout}${run.result.stderr}`);
    assert.equal(run.status.write_fee_gas, 0.00606339, unusable);
    assert.equal(run.status.alert_level, 'ok', unusable);
  }
});

test('CU-11: a pair older than its maximum age pages with a critical status and names the stale pairs', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'feed-monitor-'));
  const { result, status } = await runCu11Monitor({
    tmp,
    balanceGas: 100,
    records: [
      { pair: 'TWELVEDATA:NEO-USD', timestamp: HEADER - 60 },
      { pair: 'TWELVEDATA:BTC-USD', timestamp: HEADER - 3 * 3600 },
    ],
  });
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /FEED STALE BTC-USD/);
  assert.equal(status.alert_level, 'critical');
  assert.deepEqual(status.stale_pairs, ['BTC-USD']);
  assert.equal(status.last_write_age, 60);
  assert.equal(status.ok, false);
  // The same chain with every pair inside its window pages nothing.
  const healthy = await runCu11Monitor({
    tmp: mkdtempSync(path.join(os.tmpdir(), 'feed-monitor-')),
    balanceGas: 100,
    records: [
      { pair: 'TWELVEDATA:NEO-USD', timestamp: HEADER - 60 },
      { pair: 'TWELVEDATA:BTC-USD', timestamp: HEADER - 600 },
    ],
  });
  assert.equal(healthy.result.code, 0);
  assert.equal(healthy.status.alert_level, 'ok');
  assert.deepEqual(healthy.status.stale_pairs, []);
  assert.equal(healthy.status.last_write_age, 60);
});

test('CU-11: the monitor pages when the writer reports a TwelveData 401, an expired plan or an exhausted quota', async () => {
  for (const [category, message, kind] of [
    [
      'provider_unauthorized',
      'TwelveData upstream error (HTTP 401, code 401): Your API key is invalid',
      'unauthorized',
    ],
    [
      'subscription_expired',
      'TwelveData upstream error (HTTP 401, code 401): Your subscription has expired, please pay the last invoice',
      'expired',
    ],
    [
      'daily_quota_exhausted',
      'TwelveData upstream error (HTTP 429, code 429): You have run out of API credits for the day',
      'quota',
    ],
  ]) {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'feed-monitor-'));
    writerStatusFile(tmp, 'feed-pusher-status.json', {
      fetchError: providerError(category, message),
    });
    const { result, status } = await runCu11Monitor({ tmp, balanceGas: 100 });
    assert.equal(result.code, 1, `${category}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /ALERT: .*PROVIDER FAILURE/);
    assert.equal(status.alert_level, 'critical', category);
    assert.equal(status.ok, false);
    assert.equal(status.provider_failure.category, category);
    assert.equal(status.provider_failure.kind, kind);
    assert.equal(status.provider_failure.page, true);
    assert.ok(status.problems.some((problem) => problem.startsWith(`PROVIDER FAILURE ${kind} `)));
  }
});

test('CU-11: a transient provider failure is reported but does not page, and an old or absent report is ignored', async () => {
  const minute = mkdtempSync(path.join(os.tmpdir(), 'feed-monitor-'));
  writerStatusFile(minute, 'feed-pusher-status.json', {
    fetchError: providerError(
      'minute_rate_limited',
      'TwelveData upstream error (HTTP 429, code 429): per minute limit'
    ),
  });
  const transient = await runCu11Monitor({ tmp: minute, balanceGas: 100 });
  assert.equal(transient.result.code, 0, transient.result.stdout + transient.result.stderr);
  assert.equal(transient.status.alert_level, 'ok');
  assert.equal(transient.status.provider_failure.category, 'minute_rate_limited');
  assert.equal(transient.status.provider_failure.page, false);

  const old = mkdtempSync(path.join(os.tmpdir(), 'feed-monitor-'));
  writerStatusFile(old, 'feed-pusher-status.json', {
    fetchError: providerError('provider_unauthorized', 'TwelveData upstream error (HTTP 401)'),
    ts: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
  });
  const ignored = await runCu11Monitor({ tmp: old, balanceGas: 100 });
  assert.equal(ignored.result.code, 0);
  assert.equal(ignored.status.provider_failure, null);

  const absent = await runCu11Monitor({
    tmp: mkdtempSync(path.join(os.tmpdir(), 'feed-monitor-')),
    balanceGas: 100,
  });
  assert.equal(absent.result.code, 0);
  assert.equal(absent.status.provider_failure, null);

  const garbage = mkdtempSync(path.join(os.tmpdir(), 'feed-monitor-'));
  writeFileSync(path.join(garbage, 'feed-pusher-status.json'), '{ not json');
  const unreadable = await runCu11Monitor({ tmp: garbage, balanceGas: 100 });
  assert.equal(unreadable.result.code, 0);
  assert.equal(unreadable.status.provider_failure, null);
});

test('CU-11: the TestNet monitor reads the TestNet writer report, never the mainnet one', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'feed-monitor-'));
  // A mainnet failure next to a TestNet monitor must not page it.
  writerStatusFile(tmp, 'feed-pusher-status.json', {
    fetchError: providerError('provider_unauthorized', 'TwelveData upstream error (HTTP 401)'),
  });
  const quiet = await runCu11Monitor({
    tmp,
    balanceGas: 100,
    magic: TESTNET_MAGIC,
    env: { FEED_NETWORK: 'testnet' },
  });
  assert.equal(quiet.result.code, 0, quiet.result.stdout + quiet.result.stderr);
  assert.equal(quiet.status.provider_failure, null);
  writerStatusFile(tmp, 'feed-pusher-testnet-status.json', {
    fetchError: providerError('subscription_expired', 'TwelveData upstream error (HTTP 401)'),
  });
  const paged = await runCu11Monitor({
    tmp,
    balanceGas: 100,
    magic: TESTNET_MAGIC,
    env: { FEED_NETWORK: 'testnet' },
  });
  assert.equal(paged.result.code, 1);
  assert.equal(paged.status.provider_failure.kind, 'expired');
});

test('CU-11: the monitor builds its balance history run by run and reports the runway once it has an hour of it', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'feed-monitor-'));
  const historyFile = path.join(tmp, 'feed-status.json.balance-samples.json');
  const readHistory = () => JSON.parse(readFileSync(historyFile, 'utf8'));
  const runs = [
    { header: HEADER, gas: 80 },
    { header: HEADER + 900, gas: 79.95 },
    { header: HEADER + 3600, gas: 79.8 },
  ];
  const statuses = [];
  for (const { header, gas } of runs) {
    const records = [{ pair: 'TWELVEDATA:NEO-USD', timestamp: header - 60 }];
    const { result, status } = await runCu11Monitor({ tmp, balanceGas: gas, header, records });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    statuses.push(status);
  }
  // First run: nothing to estimate from yet, and it says so instead of claiming health.
  assert.equal(statuses[0].runway_basis, 'insufficient_history');
  assert.equal(statuses[0].runway_days, null);
  assert.equal(statuses[0].burn_gas_per_day, null);
  assert.equal(statuses[0].balance_samples, 1);
  assert.equal(statuses[1].runway_basis, 'insufficient_history');
  // Third run: an hour of samples (80 -> 79.8 GAS in 3600 s = 4.8 GAS a day, 16.6 days left).
  assert.equal(statuses[2].runway_basis, 'observed_burn');
  assert.equal(statuses[2].balance_samples, 3);
  assert.ok(Math.abs(statuses[2].burn_gas_per_day - 4.8) < 1e-6);
  assert.ok(Math.abs(statuses[2].runway_days - 79.8 / 4.8) < 1e-3);
  const history = readHistory();
  assert.equal(history.version, 1);
  assert.equal(history.network, 'mainnet');
  assert.equal(history.updater, MAINNET_UPDATER);
  assert.deepEqual(history.samples, [
    { t: HEADER, gas: 80 },
    { t: HEADER + 900, gas: 79.95 },
    { t: HEADER + 3600, gas: 79.8 },
  ]);
});

test('CU-11: an unreadable or foreign balance history is replaced, never trusted and never fatal', async () => {
  const garbage = mkdtempSync(path.join(os.tmpdir(), 'feed-monitor-'));
  writeFileSync(path.join(garbage, 'feed-status.json.balance-samples.json'), '{ truncated');
  const first = await runCu11Monitor({ tmp: garbage, balanceGas: 50 });
  assert.equal(first.result.code, 0, first.result.stdout + first.result.stderr);
  assert.equal(first.status.balance_samples, 1);
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(garbage, 'feed-status.json.balance-samples.json'), 'utf8'))
      .samples,
    [{ t: HEADER, gas: 50 }]
  );
  // A history that belongs to another updater says nothing about this one.
  const foreign = mkdtempSync(path.join(os.tmpdir(), 'feed-monitor-'));
  seedHistory(
    path.join(foreign, 'feed-status.json'),
    burnSeries({ endT: HEADER - SAMPLE_STEP_SEC, endGas: 60 }),
    { updater: '0x0000000000000000000000000000000000000001' }
  );
  const other = await runCu11Monitor({ tmp: foreign, balanceGas: 50 });
  assert.equal(other.result.code, 0);
  assert.equal(other.status.balance_samples, 1);
  assert.equal(other.status.runway_basis, 'insufficient_history');
});

test('CU-11: an unreadable registry is a critical status too', async () => {
  const server = await startMockRpc({
    roundId: 42,
    timestamp: HEADER - 60,
    gasBalance: 100e8,
    allRecords: 'fault',
    headerTime: HEADER,
  });
  const { port } = server.address();
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'feed-monitor-'));
  const statusFile = path.join(tmp, 'feed-status.json');
  try {
    const result = await runMonitor(`http://127.0.0.1:${port}`, statusFile);
    assert.equal(result.code, 2, result.stdout + result.stderr);
    const status = JSON.parse(readFileSync(statusFile, 'utf8'));
    assert.equal(status.ok, false);
    assert.equal(status.alert_level, 'critical');
  } finally {
    server.close();
  }
});
