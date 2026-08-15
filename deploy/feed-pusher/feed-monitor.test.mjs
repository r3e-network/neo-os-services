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
function startMockAllRecordsRpc({ records, gasBalance }) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const body = JSON.parse(raw);
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

function startMockRpc({ roundId, timestamp, gasBalance }) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const body = JSON.parse(raw);
        const operation = body.params && body.params[1];
        const result =
          operation === 'getLatest'
            ? { state: 'HALT', stack: [feedRecordStruct({ roundId, price: 5_250_000, timestamp })] }
            : { state: 'HALT', stack: [{ type: 'Integer', value: String(gasBalance) }] };
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
  const rows = parseAllRecords(
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
  assert.deepEqual(rows, [
    { pair: 'NEO-USD', ts: now - 120, age: 120 },
    { pair: 'BTC-USD', ts: now - 300, age: 300 },
  ]);
  // FAULT / null fall through so the caller uses the single-pair getLatest path.
  assert.equal(parseAllRecords({ state: 'FAULT', stack: [] }, now), null);
  assert.equal(parseAllRecords(null, now), null);
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
