import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  assertBackfillNetworkEnv,
  parseArgs,
  resolveBackfillEnvPath,
  resolveBackfillNetwork,
} from './backfill-feed-pairs.mjs';

test('feed backfill accepts a private external env file', () => {
  const envFile = path.resolve(path.sep, 'private', 'tmp', 'neoos-feed.env');
  const workspace = path.resolve(path.sep, 'workspace');
  const args = parseArgs([
    '--network',
    'testnet',
    '--env-file',
    envFile,
    '--symbols',
    'NEO-USD,GAS-USD',
  ]);
  assert.equal(args.network, 'testnet');
  assert.equal(resolveBackfillEnvPath(args, workspace), envFile);
  assert.deepEqual(args.symbols, ['NEO-USD', 'GAS-USD']);
});

test('feed backfill rejects ambiguous networks and cross-network env files', () => {
  assert.throws(() => resolveBackfillNetwork('staging'), /mainnet or testnet/);
  assert.throws(
    () => assertBackfillNetworkEnv('testnet', { MORPHEUS_NETWORK: 'mainnet' }),
    /does not match/
  );
  assert.throws(
    () => assertBackfillNetworkEnv('testnet', { NEO_NETWORK_MAGIC: '860833102' }),
    /does not match/
  );
  assert.doesNotThrow(() =>
    assertBackfillNetworkEnv('testnet', {
      MORPHEUS_NETWORK: 'testnet',
      NEO_NETWORK_MAGIC: '894710606',
    })
  );
});
