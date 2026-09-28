import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  readReviewedNetworkRegistry,
  readReviewedNetworkRegistrySync,
  requireNeoXNetworkLabel,
  reviewedNetworkForEvmLabel,
  resolveReviewedNeoN3Magic,
  reviewedNeoXChainId,
  resolveReviewedNeoXChainId,
} from './lib-network-registry.mjs';

test('reviewedNeoXChainId accepts only a positive safe integer from the registry', () => {
  assert.equal(reviewedNetworkForEvmLabel('neox-mainnet'), 'mainnet');
  assert.equal(reviewedNetworkForEvmLabel('neox-testnet'), 'testnet');
  assert.throws(() => reviewedNetworkForEvmLabel('neox-staging'), /unsupported EVM network label/);
  assert.equal(reviewedNeoXChainId({ neo_x: { chain_id: 47763 } }, 'mainnet'), '47763');
  assert.equal(reviewedNeoXChainId({ neo_x: { chain_id: 12227332 } }, 'testnet'), '12227332');
  for (const value of [undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '47763']) {
    assert.throws(
      () => reviewedNeoXChainId({ neo_x: { chain_id: value } }, 'mainnet'),
      /reviewed NeoX chain id/
    );
  }
  assert.equal(
    resolveReviewedNeoXChainId({ neo_x: { chain_id: 47763 } }, 'mainnet', '47763'),
    '47763'
  );
  assert.throws(
    () => resolveReviewedNeoXChainId({ neo_x: { chain_id: 47763 } }, 'mainnet', '47764'),
    /conflicts with reviewed/
  );
  assert.equal(
    resolveReviewedNeoN3Magic({ neo_n3: { network_magic: 860833102 } }, 'mainnet', '860833102'),
    '860833102'
  );
  assert.throws(
    () => resolveReviewedNeoN3Magic({ neo_n3: { network_magic: 860833102 } }, 'mainnet', '1'),
    /conflicts with reviewed/
  );
});

test('Neo X tools get their network only from an explicit NEOX_NET', () => {
  for (const missing of [undefined, null, '', '   ']) {
    assert.throws(() => requireNeoXNetworkLabel(missing), /NEOX_NET is required/);
  }
  assert.throws(() => requireNeoXNetworkLabel('neox-staging'), /unsupported EVM network label/);
  assert.equal(requireNeoXNetworkLabel('neox-mainnet'), 'neox-mainnet');
  assert.equal(requireNeoXNetworkLabel(' neox-testnet '), 'neox-testnet');
});

test('sync registry loading validates the selected network identities', () => {
  const registry = readReviewedNetworkRegistrySync(process.cwd(), 'testnet');
  assert.equal(registry.network, 'testnet');
  assert.equal(registry.neo_x.chain_id, 12227332);
});

test('readReviewedNetworkRegistry rejects an incomplete or cross-network identity', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'network-registry-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const networkDirectory = path.join(directory, 'config', 'networks');
  fs.mkdirSync(networkDirectory, { recursive: true });
  const file = path.join(networkDirectory, 'mainnet.json');

  fs.writeFileSync(
    file,
    JSON.stringify({ network: 'testnet', neo_x: { chain_id: 47763 } }),
    'utf8'
  );
  await assert.rejects(readReviewedNetworkRegistry(directory, 'mainnet'), /names testnet/);

  fs.writeFileSync(
    file,
    JSON.stringify({ network: 'mainnet', neo_x: { chain_id: 47763 } }),
    'utf8'
  );
  await assert.rejects(readReviewedNetworkRegistry(directory, 'mainnet'), /Neo N3 magic/);
});
