import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SCRIPT = path.join(ROOT, 'scripts', 'upgrade-morpheus-datafeed.mjs');
const TARGET = '0x00112233445566778899aabbccddeeff00112233';

function baseEnv() {
  return {
    ...process.env,
    MORPHEUS_NETWORK: 'testnet',
    CONTRACT_MORPHEUS_DATAFEED_HASH: TARGET,
    NEO_NETWORK_MAGIC: '894710606',
    NEO_RPC_URL: 'https://example.invalid/testnet',
    UPGRADE_APPLY: '',
  };
}

test('datafeed upgrade is a read-only dry run by default', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--network', 'testnet'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: baseEnv(),
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, 'DRY_RUN');
  assert.equal(report.broadcast, false);
  assert.equal(report.datafeed_hash, TARGET);
  assert.match(report.next_step, /--apply --network testnet/);
  assert.doesNotMatch(result.stdout, /update tx/i);
});

test('datafeed upgrade requires an explicit network before apply', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--apply'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...baseEnv(), CONTRACT_MORPHEUS_DATAFEED_HASH: TARGET },
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /--apply requires explicit --network/i);
});

test('legacy implicit apply environment is rejected', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--network', 'testnet'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...baseEnv(), UPGRADE_APPLY: '1' },
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /UPGRADE_APPLY.*--apply/i);
});
