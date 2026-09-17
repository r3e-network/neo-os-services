import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const MONITOR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'feed-monitor.mjs');

process.env.FEED_MONITOR_SKIP_MAIN = '1';
const { parseAllRecords, isMarketClosed, staleAgeLimit, renderPromText } =
  await import('./feed-monitor.mjs');

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
              stack: [{ type: 'Array', value: [feedRecordStruct({ roundId, price: 5_250_000, timestamp })] }],
            };
        } else if (operation === 'getLatest') {
          result = { state: 'HALT', stack: [feedRecordStruct({ roundId, price: 5_250_000, timestamp })] };
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
  assert.equal(parseAllRecords({ state: 'HALT', stack: [{ type: 'Array', value: [] }] }, now).reason, 'empty');
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
