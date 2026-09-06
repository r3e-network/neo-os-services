import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseRustFeedRegistry,
  parseRustFeedSignMapping,
  parseRustRetiredPairs,
  sameTwelveDataInstrument,
} from './check-feed-pair-registries.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = path.join(REPO_ROOT, 'scripts', 'check-feed-pair-registries.mjs');

function runCheck(extraArgs = []) {
  return spawnSync(process.execPath, [CHECK, '--json', ...extraArgs], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, FEED_PUSHER_SKIP_MAIN: '1' },
  });
}

// Static mode reads the Rust authority plus checked-in projections/compatibility
// mirrors and makes no network calls, so it is safe in CI. `--onchain` is omitted.
test('the Rust authority, advertised/runtime projections, and Node compatibility mirrors agree', () => {
  const result = runCheck();
  const report = JSON.parse(result.stdout);
  assert.deepEqual(
    report.failures,
    [],
    `feed pair registries disagree:\n  ${report.failures.join('\n  ')}`
  );
  assert.equal(report.status, 'pass');
  assert.equal(result.status, 0);
});

// Guards against the check quietly becoming a no-op: if it ever reports zero pairs
// (a parser that stopped matching, an empty registry) it would "pass" while proving
// nothing. Every registry must contribute the same non-trivial count.
test('the check actually compared a non-trivial, equal number of pairs', () => {
  const report = JSON.parse(runCheck().stdout);
  assert.ok(report.rust_feed_sign_pair_count > 20, 'Rust /feed/sign map looks empty or truncated');
  assert.equal(report.rust_registry_pair_count, report.rust_feed_sign_pair_count);
  assert.equal(report.advertised_pair_count, report.rust_feed_sign_pair_count);
  assert.equal(report.node_pusher_compat_pair_count, report.advertised_pair_count);
  assert.equal(report.node_worker_compat_pair_count, report.advertised_pair_count);
  assert.equal(report.runtime_pair_count, report.advertised_pair_count);
});

test('the checker parses the Rust delivery mappings and their explicit inverse semantics', () => {
  const rustRegistrySource = fs.readFileSync(
    path.join(REPO_ROOT, 'crates', 'neo-os-compute', 'src', 'oracle', 'feed_registry.rs'),
    'utf8'
  );
  const feedSignSource = fs.readFileSync(
    path.join(REPO_ROOT, 'workers', 'nitro-enclave-host', 'src', 'feed_sign.rs'),
    'utf8'
  );
  const registry = parseRustFeedRegistry(rustRegistrySource);
  const writer = parseRustFeedSignMapping(feedSignSource);
  const retired = parseRustRetiredPairs(rustRegistrySource);

  assert.equal(writer.get('CORN-USD'), 'C_1');
  assert.deepEqual(registry.get('CORN-USD'), { symbol: 'C_1', priceTransform: null });
  assert.equal(writer.get('JPY-USD'), 'JPY/USD');
  assert.deepEqual(registry.get('JPY-USD'), {
    symbol: 'USD/JPY',
    priceTransform: 'inverse',
  });
  assert.ok(sameTwelveDataInstrument(writer.get('JPY-USD'), registry.get('JPY-USD')));
  assert.ok(!sameTwelveDataInstrument('JPY/USD', { symbol: 'USD/JPY', priceTransform: null }));
  assert.ok(retired.has('COPPER-USD'));
});

// The two known wrong-asset mappings must stay retired. TwelveData resolves HG1 to
// Homag Group AG rather than copper, and FLM/USD to FolmCoin rather than Flamingo
// Finance; both were publishing the wrong instrument under a right-looking pair name.
test('the known unsourceable pairs stay retired', () => {
  const report = JSON.parse(runCheck().stdout);
  for (const pair of ['COPPER-USD', 'FLM-USD', '1000FLM-USD', '1000JPY-USD']) {
    assert.ok(report.retired_pairs.includes(pair), `${pair} must remain retired`);
  }
});
