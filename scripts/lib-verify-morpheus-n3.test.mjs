import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectMorpheusOracleInterface,
  resolveNetworkScopedValue,
} from './lib-verify-morpheus-n3.mjs';

test('verify:n3 value resolution prefers selected deployment env over stale root env', () => {
  const value = resolveNetworkScopedValue({
    network: 'mainnet',
    genericKey: 'CONTRACT_MORPHEUS_ORACLE_HASH',
    mainnetKey: 'CONTRACT_MORPHEUS_ORACLE_HASH_MAINNET',
    testnetKey: 'CONTRACT_MORPHEUS_ORACLE_HASH_TESTNET',
    explicitEnv: {},
    selectedEnv: {
      CONTRACT_MORPHEUS_ORACLE_HASH: '0xselected-mainnet-deployment',
    },
    loadedEnv: {
      CONTRACT_MORPHEUS_ORACLE_HASH_MAINNET: '0xstale-root-mainnet',
      CONTRACT_MORPHEUS_ORACLE_HASH: '0xroot-generic',
    },
    registryValue: '0xregistry',
  });

  assert.equal(value, '0xselected-mainnet-deployment');
});

test('verify:n3 value resolution keeps explicit shell overrides authoritative', () => {
  const value = resolveNetworkScopedValue({
    network: 'mainnet',
    genericKey: 'CONTRACT_MORPHEUS_ORACLE_HASH',
    mainnetKey: 'CONTRACT_MORPHEUS_ORACLE_HASH_MAINNET',
    testnetKey: 'CONTRACT_MORPHEUS_ORACLE_HASH_TESTNET',
    explicitEnv: {
      CONTRACT_MORPHEUS_ORACLE_HASH_MAINNET: '0xexplicit-mainnet',
    },
    selectedEnv: {
      CONTRACT_MORPHEUS_ORACLE_HASH: '0xselected-mainnet-deployment',
    },
    loadedEnv: {},
    registryValue: '0xregistry',
  });

  assert.equal(value, '0xexplicit-mainnet');
});

test('verify:n3 detects legacy and miniapp MorpheusOracle ABIs', () => {
  assert.equal(
    detectMorpheusOracleInterface(['request/4', 'isAllowedCallback/1', 'addAllowedCallback/1']),
    'legacy_callback'
  );
  assert.equal(
    detectMorpheusOracleInterface(['request/4', 'submitMiniAppRequest/4', 'getMiniAppCount/0']),
    'miniapp_runtime'
  );
  assert.equal(detectMorpheusOracleInterface(['request/4']), 'unknown');
});
