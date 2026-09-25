import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  assertOracleKeyTimelockAbi,
  readOracleContractState,
  resolveOracleAdminWif,
} from './lib-oracle-timelock.mjs';

const method = (name, parameters = [], returntype = 'Void', safe = false) => ({
  name,
  parameters,
  returntype,
  safe,
});

const stateWithMethods = (methods, name = 'MorpheusOracle') => ({
  manifest: { name, abi: { methods } },
});
const CONTRACT_HASH = '0xf54d8584ef82315c1800373272ab08ae0db2d5ef';

const fullContractStateFixture = (overrides = {}) => ({
  id: 7508,
  hash: CONTRACT_HASH,
  nef: {
    magic: 894710606,
    compiler: 'neoos-test-fixture',
    source: 'fixture',
    tokens: [],
    script: '00',
    checksum: 0,
  },
  manifest: stateWithMethods([]).manifest,
  updatecounter: 1,
  ...overrides,
});

const LEGACY_LIVE_METHOD_NAMES = Object.freeze([
  '_deploy',
  'admin',
  'updater',
  'runtimeEncryptionAlgorithm',
  'runtimeEncryptionPublicKey',
  'runtimeEncryptionKeyVersion',
  'runtimeVerificationPublicKey',
  'oracleEncryptionAlgorithm',
  'oracleEncryptionPublicKey',
  'oracleEncryptionKeyVersion',
  'oracleVerificationPublicKey',
  'systemRequestFee',
  'requestFee',
  'requestTTL',
  'feeCreditOf',
  'accruedRequestFees',
  'reservedRequestFees',
  'withdrawableFees',
  'getMiniAppCount',
  'getSystemModuleCount',
  'getMiniAppIdByIndex',
  'getSystemModuleIdByIndex',
  'getAllMiniAppIds',
  'getAllSystemModuleIds',
  'getMiniApp',
  'getSystemModule',
  'isModuleGrantedToMiniApp',
  'getMiniAppRequestCount',
  'getMiniAppFulfilledCount',
  'getTotalRequests',
  'getTotalFulfilled',
  'getRequest',
  'getInboxItem',
  'getMiniAppState',
  'setAdmin',
  'setUpdater',
  'setRuntimeEncryptionKey',
  'setOracleEncryptionKey',
  'setRuntimeVerificationPublicKey',
  'setOracleVerificationPublicKey',
  'setRequestFee',
  'withdrawAccruedFees',
  'setRequestTTL',
  'expireStaleRequest',
  'registerSystemModule',
  'configureSystemModule',
  'registerMiniApp',
  'configureMiniApp',
  'grantModuleToMiniApp',
  'revokeModuleFromMiniApp',
  'putMiniAppState',
  'putMiniAppStateBatch',
  'deleteMiniAppState',
  'submitMiniAppRequest',
  'submitMiniAppRequestFromIntegration',
  'requestFromCallback',
  'queueSystemRequest',
  'queueAutomationRequest',
  'request',
  'onNEP17Payment',
  'fulfillRequest',
  'update',
  'rebuildIndexes',
  '_initialize',
]);

assert.equal(LEGACY_LIVE_METHOD_NAMES.length, 64);

async function readCheckedInManifest() {
  const source = await fs.readFile(
    path.resolve('contracts/__tests__/Generated/MorpheusOracle.artifacts.cs'),
    'utf8'
  );
  const match = source.match(/ContractManifest\.Parse\(@"([\s\S]*?)"\);/);
  assert.ok(match, 'checked-in MorpheusOracle manifest fixture is missing');
  return JSON.parse(match[1].replaceAll('""', '"'));
}

test('rejects the live 64-method oracle ABI before any key publish', () => {
  const legacyMethods = LEGACY_LIVE_METHOD_NAMES.map((name) => method(name));
  assert.equal(legacyMethods.length, 64);
  assert.throws(
    () => assertOracleKeyTimelockAbi(stateWithMethods(legacyMethods), 'encryption'),
    /24h timelock.*proposeRuntimeEncryptionKey.*executeRuntimeEncryptionKey/i
  );
});

test('accepts the complete checked-in lower-camel MorpheusOracle manifest', async () => {
  const state = { manifest: await readCheckedInManifest() };
  assert.ok(state.manifest.abi.methods.length > 64);
  assert.equal(assertOracleKeyTimelockAbi(state, 'encryption').kind, 'encryption');
  assert.equal(assertOracleKeyTimelockAbi(state, 'verification').kind, 'verification');
});

test('accepts every required verifier-key timelock method', () => {
  assert.equal(
    assertOracleKeyTimelockAbi(
      stateWithMethods([
        method('proposeRuntimeVerificationPublicKey', [{ name: 'publicKey', type: 'PublicKey' }]),
        method('executeRuntimeVerificationPublicKey'),
        method('cancelRuntimeVerificationPublicKey'),
        method('pendingRuntimeVerificationKeyEta', [], 'Integer', true),
      ]),
      'verification'
    ).kind,
    'verification'
  );
});

test('requires the exact lower-camel ABI shape for both key lanes', () => {
  const encryption = [
    method('proposeRuntimeEncryptionKey', [
      { name: 'algorithm', type: 'String' },
      { name: 'publicKey', type: 'String' },
    ]),
    method('executeRuntimeEncryptionKey'),
    method('cancelRuntimeEncryptionKey'),
    method('pendingRuntimeEncryptionKeyEta', [], 'Integer', true),
  ];
  assert.equal(
    assertOracleKeyTimelockAbi(stateWithMethods(encryption), 'encryption').execute,
    'executeRuntimeEncryptionKey'
  );

  const malformed = encryption.map((entry) => ({ ...entry }));
  malformed[0] = method('proposeRuntimeEncryptionKey', [{ name: 'publicKey', type: 'ByteArray' }]);
  assert.throws(
    () => assertOracleKeyTimelockAbi(stateWithMethods(malformed), 'encryption'),
    /ABI mismatch.*proposeRuntimeEncryptionKey/i
  );
  const malformedParameterName = structuredClone(encryption);
  malformedParameterName[0].parameters[0].name = 'keyAlgorithm';
  assert.throws(
    () => assertOracleKeyTimelockAbi(stateWithMethods(malformedParameterName), 'encryption'),
    /ABI mismatch.*proposeRuntimeEncryptionKey/i
  );

  const verification = [
    method('proposeRuntimeVerificationPublicKey', [{ name: 'publicKey', type: 'PublicKey' }]),
    method('executeRuntimeVerificationPublicKey'),
    method('cancelRuntimeVerificationPublicKey'),
    method('pendingRuntimeVerificationKeyEta', [], 'Integer', true),
  ];
  assert.equal(
    assertOracleKeyTimelockAbi(stateWithMethods(verification), 'verification').eta,
    'pendingRuntimeVerificationKeyEta'
  );
  const malformedVerification = verification.map((entry) => ({ ...entry }));
  malformedVerification[3] = method('pendingRuntimeVerificationKeyEta', [], 'Integer', false);
  assert.throws(
    () => assertOracleKeyTimelockAbi(stateWithMethods(malformedVerification), 'verification'),
    /ABI mismatch.*pendingRuntimeVerificationKeyEta/i
  );
});

test('rejects every per-method shape mutation in both key lanes', () => {
  const lanes = {
    encryption: [
      method('proposeRuntimeEncryptionKey', [
        { name: 'algorithm', type: 'String' },
        { name: 'publicKey', type: 'String' },
      ]),
      method('executeRuntimeEncryptionKey'),
      method('cancelRuntimeEncryptionKey'),
      method('pendingRuntimeEncryptionKeyEta', [], 'Integer', true),
    ],
    verification: [
      method('proposeRuntimeVerificationPublicKey', [{ name: 'publicKey', type: 'PublicKey' }]),
      method('executeRuntimeVerificationPublicKey'),
      method('cancelRuntimeVerificationPublicKey'),
      method('pendingRuntimeVerificationKeyEta', [], 'Integer', true),
    ],
  };

  for (const [kind, definitions] of Object.entries(lanes)) {
    for (let index = 0; index < definitions.length; index += 1) {
      const mutated = structuredClone(definitions);
      if (index === 0) mutated[index].parameters[0].type = 'ByteArray';
      if (index === 1) mutated[index].returntype = 'Integer';
      if (index === 2) mutated[index].safe = true;
      if (index === 3) mutated[index].parameters = [{ name: 'unexpected', type: 'String' }];
      assert.throws(
        () => assertOracleKeyTimelockAbi(stateWithMethods(mutated), kind),
        /ABI mismatch/
      );
    }
  }
});

test('rejects a missing manifest ABI and duplicate ABI method names', () => {
  const methods = [
    method('proposeRuntimeEncryptionKey', [
      { name: 'algorithm', type: 'String' },
      { name: 'publicKey', type: 'String' },
    ]),
    method('executeRuntimeEncryptionKey'),
    method('cancelRuntimeEncryptionKey'),
    method('pendingRuntimeEncryptionKeyEta', [], 'Integer', true),
  ];
  assert.throws(
    () =>
      assertOracleKeyTimelockAbi(
        { manifest: { name: 'MorpheusOracle' }, abi: { methods } },
        'encryption'
      ),
    /ABI methods are missing/
  );
  assert.throws(
    () =>
      assertOracleKeyTimelockAbi(
        stateWithMethods([...methods, method('executeRuntimeEncryptionKey')]),
        'encryption'
      ),
    /duplicate ABI method.*executeRuntimeEncryptionKey/i
  );
  assert.throws(
    () => assertOracleKeyTimelockAbi(stateWithMethods([...methods, null]), 'encryption'),
    /malformed method entry/
  );
  assert.throws(
    () =>
      assertOracleKeyTimelockAbi(stateWithMethods([...methods, { name: 'extra' }]), 'encryption'),
    /malformed method entry/
  );
  assert.throws(
    () =>
      assertOracleKeyTimelockAbi(
        stateWithMethods([...methods, method('unrelated', [{ type: 'String' }])]),
        'encryption'
      ),
    /malformed method entry/
  );
});

test('reads only getcontractstate and fails closed on an RPC error', async () => {
  let request;
  const state = await readOracleContractState(
    'https://rpc.example.invalid',
    CONTRACT_HASH,
    async (_url, init) => {
      request = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 'neoos-oracle-timelock-probe',
          result: fullContractStateFixture({
            manifest: stateWithMethods([method('method')]).manifest,
          }),
        }),
      };
    }
  );
  assert.deepEqual(request, {
    jsonrpc: '2.0',
    id: 'neoos-oracle-timelock-probe',
    method: 'getcontractstate',
    params: [CONTRACT_HASH],
  });
  assert.ok(state.manifest.abi.methods.length === 1);
  await assert.rejects(
    () =>
      readOracleContractState('https://rpc.example.invalid', CONTRACT_HASH, async () => ({
        ok: false,
        status: 503,
      })),
    /HTTP 503/
  );
  await assert.rejects(
    () =>
      readOracleContractState('https://rpc.example.invalid', CONTRACT_HASH, async () => ({
        ok: true,
        json: async () => ({
          jsonrpc: '1.0',
          id: 'neoos-oracle-timelock-probe',
          result: fullContractStateFixture(),
        }),
      })),
    /mismatched JSON-RPC response/
  );
  await assert.rejects(
    () =>
      readOracleContractState('https://rpc.example.invalid', CONTRACT_HASH, async () => ({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 'neoos-oracle-timelock-probe',
          error: { code: -32600, message: 'invalid request' },
        }),
      })),
    /RPC error.*invalid request/
  );
});

test('binds the ABI probe to the exact JSON-RPC response and contract hash', async () => {
  const response = (overrides = {}, id = 'neoos-oracle-timelock-probe') => ({
    ok: true,
    json: async () => ({
      jsonrpc: '2.0',
      id,
      result: fullContractStateFixture(overrides),
    }),
  });
  const state = await readOracleContractState(
    'https://rpc.example.invalid',
    CONTRACT_HASH,
    async () => response()
  );
  assert.equal(state.hash, CONTRACT_HASH);
  await assert.rejects(
    () =>
      readOracleContractState('https://rpc.example.invalid', CONTRACT_HASH, async () =>
        response({}, 'wrong-id')
      ),
    /mismatched JSON-RPC response/
  );
  await assert.rejects(
    () =>
      readOracleContractState('https://rpc.example.invalid', CONTRACT_HASH, async () =>
        response({ hash: '0x0000000000000000000000000000000000000000' })
      ),
    /different contract hash/
  );
});

test('requires an explicit Oracle admin signer and never substitutes the updater', () => {
  assert.equal(resolveOracleAdminWif({ MORPHEUS_ORACLE_ADMIN_WIF: 'admin-wif' }), 'admin-wif');
  assert.equal(resolveOracleAdminWif({ NEO_N3_ADMIN_WIF: 'legacy-admin-wif' }), 'legacy-admin-wif');
  assert.throws(
    () => resolveOracleAdminWif({ MORPHEUS_UPDATER_NEO_N3_WIF_TESTNET: 'updater-wif' }),
    /updater key is not an admin substitute/i
  );
});

test('both publisher scripts probe the deployed ABI before the not-live claim', async () => {
  const expectedProposeMethods = {
    'publish-oracle-verifier-key.mjs': 'proposeRuntimeVerificationPublicKey',
    'publish-oracle-public-key.mjs': 'proposeRuntimeEncryptionKey',
  };
  for (const [file, proposeMethod] of Object.entries(expectedProposeMethods)) {
    const source = await fs.readFile(path.resolve('scripts', file), 'utf8');
    assert.match(source, /readOracleContractState\(rpcUrl, oracleHash\)/, file);
    assert.match(source, /resolveOracleAdminWif\(process\.env\)/, file);
    assert.doesNotMatch(source, /resolvePinnedNeoN3Role\([^\n]*['"]updater['"]/, file);
    assert.match(source, /assertOracleKeyTimelockAbi\(/, file);
    assert.ok(
      source.indexOf('assertOracleKeyTimelockAbi(') < source.indexOf('NOT LIVE YET'),
      `${file} must verify the deployed ABI before claiming a timelock`
    );
    assert.match(source, new RegExp(`invoke\\('${proposeMethod}'`), file);
    assert.doesNotMatch(source, /invoke\('setOracle(?:EncryptionKey|VerificationPublicKey)'/, file);
  }
});
