import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { assertOracleKeyTimelockAbi, readOracleContractState } from './lib-oracle-timelock.mjs';

const contractHash = '0x' + 'f54d8584'.padEnd(40, '0');
const methodDefinitions = {
  proposeRuntimeVerificationPublicKey: [{ name: 'publicKey', type: 'PublicKey' }],
  executeRuntimeVerificationPublicKey: [],
  cancelRuntimeVerificationPublicKey: [],
  pendingRuntimeVerificationKeyEta: [],
  proposeRuntimeEncryptionKey: [
    { name: 'algorithm', type: 'String' },
    { name: 'publicKey', type: 'String' },
  ],
  executeRuntimeEncryptionKey: [],
  cancelRuntimeEncryptionKey: [],
  pendingRuntimeEncryptionKeyEta: [],
};
const methods = (...names) => ({
  hash: contractHash,
  manifest: {
    name: 'MorpheusOracle',
    abi: {
      methods: names.map((name) => ({
        name,
        parameters: methodDefinitions[name] || [],
        returntype: name.startsWith('pending') ? 'Integer' : 'Void',
        safe: name.startsWith('pending'),
      })),
    },
  },
});

test('accepts the complete verifier-key timelock ABI', () => {
  assert.equal(
    assertOracleKeyTimelockAbi(
      methods(
        'proposeRuntimeVerificationPublicKey',
        'executeRuntimeVerificationPublicKey',
        'cancelRuntimeVerificationPublicKey',
        'pendingRuntimeVerificationKeyEta'
      ),
      'verification'
    ).kind,
    'verification'
  );
});

test('accepts the complete encryption-key timelock ABI', () => {
  assert.equal(
    assertOracleKeyTimelockAbi(
      methods(
        'proposeRuntimeEncryptionKey',
        'executeRuntimeEncryptionKey',
        'cancelRuntimeEncryptionKey',
        'pendingRuntimeEncryptionKeyEta'
      ),
      'encryption'
    ).execute,
    'executeRuntimeEncryptionKey'
  );
});

test('refuses a deployed ABI that exposes only the immediate set alias', () => {
  assert.throws(
    () =>
      assertOracleKeyTimelockAbi(
        methods('setOracleVerificationPublicKey', 'runtimeVerificationPublicKey'),
        'verification'
      ),
    /24h timelock.*proposeRuntimeVerificationPublicKey.*executeRuntimeVerificationPublicKey/i
  );
});

test('refuses the recorded deployed 64-method kernel ABI without runtime timelocks', () => {
  const recordedMethods = Array.from({ length: 64 }, (_, index) => `legacyMethod${index}`);
  assert.throws(
    () => assertOracleKeyTimelockAbi(methods(...recordedMethods), 'encryption'),
    /24h timelock.*proposeRuntimeEncryptionKey.*executeRuntimeEncryptionKey/i
  );
});

test('refuses malformed or unknown timelock kinds', () => {
  assert.throws(
    () => assertOracleKeyTimelockAbi({ manifest: { name: 'MorpheusOracle' } }, 'verification'),
    /ABI methods are missing/
  );
  assert.throws(
    () => assertOracleKeyTimelockAbi(methods('proposeRuntimeEncryptionKey'), 'unknown'),
    /unknown oracle key kind/
  );
});

test('probes getcontractstate and fails closed on RPC transport errors', async () => {
  let request;
  const state = await readOracleContractState(
    'https://rpc.example.invalid',
    contractHash,
    async (_url, init) => {
      request = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 'neoos-oracle-timelock-probe',
          result: { hash: contractHash, manifest: { abi: { methods: [] } } },
        }),
      };
    }
  );
  assert.deepEqual(request, {
    jsonrpc: '2.0',
    id: 'neoos-oracle-timelock-probe',
    method: 'getcontractstate',
    params: [contractHash],
  });
  assert.equal(state.manifest.abi.methods.length, 0);
  await assert.rejects(
    () =>
      readOracleContractState('https://rpc.example.invalid', contractHash, async () => ({
        ok: false,
        status: 503,
      })),
    /HTTP 503/
  );
  await assert.rejects(
    () =>
      readOracleContractState('https://rpc.example.invalid', contractHash, async () => ({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 'neoos-oracle-timelock-probe',
          result: { manifest: { abi: { methods: [] } } },
        }),
      })),
    /different contract hash/
  );
  await assert.rejects(async () => {
    assertOracleKeyTimelockAbi(
      { hash: contractHash, manifest: { abi: { methods: [] } } },
      'encryption'
    );
  }, /manifest name is not MorpheusOracle/);
});

test('both publishing scripts guard the NOT LIVE YET claim with the ABI probe', async () => {
  for (const file of ['publish-oracle-verifier-key.mjs', 'publish-oracle-public-key.mjs']) {
    const source = await fs.readFile(path.resolve('scripts', file), 'utf8');
    assert.match(source, /readOracleContractState\(rpcUrl, oracleHash\)/, file);
    assert.match(source, /assertOracleKeyTimelockAbi\(/, file);
    assert.ok(
      source.indexOf('assertOracleKeyTimelockAbi(') < source.indexOf('fetch(`${nitroUrl}'),
      `${file} must verify the deployed ABI before reading a replacement key`
    );
    assert.ok(
      source.indexOf('assertOracleKeyTimelockAbi(') < source.indexOf('NOT LIVE YET'),
      `${file} must verify the deployed ABI before claiming a timelock`
    );
  }
});

test('documents the deployed kernel timelock gap and removes the stale signer split claim', async () => {
  const read = (file) => fs.readFile(path.resolve(file), 'utf8');
  const servicesReadme = await read('README.md');
  const blockers = await read('docs/EXTERNAL_RELEASE_BLOCKERS.md');
  const contractsReadme = await read('contracts/README.md');
  assert.doesNotMatch(servicesReadme, /Today signing is split across[\s\S]*?behind the service\./);
  assert.match(blockers, /deployed MorpheusOracle[\s\S]*?no runtime-key timelock/i);
  assert.match(contractsReadme, /deployed MorpheusOracle[\s\S]*?does not expose[\s\S]*?timelock/i);
});
