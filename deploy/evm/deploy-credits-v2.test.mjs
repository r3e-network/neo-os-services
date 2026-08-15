import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AbiCoder, sha256 } from 'ethers';

import {
  CREDITS_PER_GAS,
  GAS_WEI_PER_CREDIT,
  MAINNET_ACK,
  NEO_X_MAINNET_CHAIN_ID,
  loadCreditsArtifacts,
  validateCreditsDeployConfig,
} from './deploy-credits-v2.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'deploy-credits-v2.mjs');
const VECTOR_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../contracts-evm/testdata/MiniAppCreditsV2.batch-root-vectors.json'
);
const SETTLER = '0x0000000000000000000000000000000000005000';

test('deployment target and exchange rate are immutable Neo X MainNet values', () => {
  assert.equal(NEO_X_MAINNET_CHAIN_ID, 47_763n);
  assert.equal(GAS_WEI_PER_CREDIT, 10n ** 16n);
  assert.equal(CREDITS_PER_GAS, 100n);
  assert.equal(MAINNET_ACK, 'neo-x-mainnet:47763');
});

test('default invocation is an offline non-broadcast plan', () => {
  const result = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: { NEOX_CREDITS_V2_SETTLER: SETTLER },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /DRY RUN ONLY/);
  assert.match(result.stdout, /no RPC connection, key access, broadcast, or production enablement/);
});

test('broadcast requires the exact mainnet acknowledgement before RPC or key use', () => {
  assert.throws(
    () =>
      validateCreditsDeployConfig({
        NEOX_CREDITS_V2_SETTLER: SETTLER,
        DEPLOY_APPLY: '1',
      }),
    /NEOX_CREDITS_V2_MAINNET_ACK=neo-x-mainnet:47763/
  );
});

test('configuration rejects zero settler and chain acknowledgement variants', () => {
  assert.throws(
    () =>
      validateCreditsDeployConfig({
        NEOX_CREDITS_V2_SETTLER: '0x0000000000000000000000000000000000000000',
      }),
    /non-zero EVM address/
  );
  assert.throws(
    () =>
      validateCreditsDeployConfig({
        NEOX_CREDITS_V2_SETTLER: SETTLER,
        DEPLOY_APPLY: '1',
        NEOX_CREDITS_V2_MAINNET_ACK: 'neo-x-testnet:12227332',
      }),
    /neo-x-mainnet:47763/
  );
});

test('compiled ABI exposes the strict seven-field settlement proof event', () => {
  const { abi, bytecode } = loadCreditsArtifacts();
  const event = abi.find((entry) => entry.type === 'event' && entry.name === 'SettlementPosted');
  assert.deepEqual(
    event.inputs.map((input) => input.name),
    [
      'epoch',
      'batchRoot',
      'windowStartExclusive',
      'windowEndInclusive',
      'userCount',
      'totalRequested',
      'totalDebited',
    ]
  );
  const functions = new Set(
    abi.filter((entry) => entry.type === 'function').map((entry) => entry.name)
  );
  assert.equal(functions.has('rescueSurplusGas'), true);
  for (const forbidden of ['refundCredits', 'requestExit', 'approveExit', 'claimExit']) {
    assert.equal(functions.has(forbidden), false, `${forbidden} must not be exposed`);
  }
  assert.match(bytecode, /^0x[0-9a-f]+$/i);
});

test('shared ABI-encoding batch root vector is stable for the 081 settler', () => {
  const fixture = JSON.parse(readFileSync(VECTOR_PATH, 'utf8'));
  const vector = fixture.vectors[0];
  const encoded = AbiCoder.defaultAbiCoder().encode(
    ['string', 'uint256', 'address', 'uint256', 'uint256', 'uint256', 'address[]', 'int256[]'],
    [
      fixture.domain,
      BigInt(vector.chainId),
      vector.contract,
      BigInt(vector.epoch),
      BigInt(vector.windowStartExclusive),
      BigInt(vector.windowEndInclusive),
      vector.users,
      vector.deltas.map(BigInt),
    ]
  );
  assert.equal(sha256(encoded), vector.expectedBatchRoot);
});
