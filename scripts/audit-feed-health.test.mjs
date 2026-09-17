import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { runFeedHealthAudit } from './audit-feed-health.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'audit-feed-health.mjs');

test('audit-feed-health CLI rejects an unknown network before touching RPC', () => {
  const result = spawnSync(process.execPath, [CLI, '--network', 'devnet'], {
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--network must be all, mainnet, or testnet/);
});

test('runFeedHealthAudit exits 1 when a readable network is stale', async () => {
  const stdout = [];
  const result = await runFeedHealthAudit(['--network', 'testnet', '--json'], {
    buildReport: async () => ({
      network: 'testnet',
      ok: false,
      readable: true,
      headline: 'FEED HEALTH testnet FAIL',
      root_causes: [],
      ruled_out: [],
      live_blockers: [],
      counts: { active_stale: 1, active: 1, clock_skew: 0 },
    }),
    writeStdout: (line) => stdout.push(line),
    writeStderr: () => {},
  });
  assert.equal(result.exit_code, 1);
  assert.match(stdout.join('\n'), /"exit_code": 1/);
});

test('runFeedHealthAudit exits 2 when getAllFeedRecords is unreadable', async () => {
  const stderr = [];
  const result = await runFeedHealthAudit(['--network', 'testnet'], {
    buildReport: async () => ({
      network: 'testnet',
      ok: false,
      readable: false,
      unreadable_reason: 'fault',
      headline: 'FEED HEALTH testnet UNREADABLE',
      root_causes: [{ severity: 'confirmed', code: 'getAllFeedRecords_unreadable', summary: 'FAULT' }],
      ruled_out: [],
      live_blockers: [],
      counts: { active_stale: 0, active: 0, clock_skew: 0 },
    }),
    writeStdout: () => {},
    writeStderr: (line) => stderr.push(line),
  });
  assert.equal(result.exit_code, 2);
  assert.match(stderr.join('\n'), /UNREADABLE/);
});

test('runFeedHealthAudit CLI path still throws parse errors as exit 2', async () => {
  await assert.rejects(() => runFeedHealthAudit(['--network', 'devnet']), /--network must be/);
});
