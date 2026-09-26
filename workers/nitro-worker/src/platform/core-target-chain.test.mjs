import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeMorpheusNetwork,
  normalizeTargetChain,
  resolvePayloadNetwork,
  resolveReviewedNeoNetworkMagic,
  SUPPORTED_ORACLE_TARGET_CHAINS,
} from './core.js';

test('worker accepts both Neo N3 and Neo X target chains', () => {
  assert.ok(SUPPORTED_ORACLE_TARGET_CHAINS.has('neo_n3'));
  assert.ok(SUPPORTED_ORACLE_TARGET_CHAINS.has('neox'));
  assert.equal(normalizeTargetChain('neo_n3'), 'neo_n3');
  assert.equal(normalizeTargetChain('neox'), 'neox');
  assert.equal(normalizeTargetChain('NEOX'), 'neox');
  assert.equal(normalizeTargetChain(undefined), 'neo_n3'); // default
});

test('worker rejects unknown target chains', () => {
  assert.throws(() => normalizeTargetChain('ethereum'), /unsupported target_chain/);
  assert.throws(() => normalizeTargetChain('solana'), /unsupported target_chain/);
});

test('worker rejects an unknown explicit Neo network instead of falling back', () => {
  assert.throws(() => normalizeMorpheusNetwork('staging'), /unsupported Neo network/);
});

test('worker rejects explicit non-string network values instead of falling back', () => {
  assert.throws(() => normalizeMorpheusNetwork(false), /unsupported Neo network/);
  assert.throws(() => normalizeMorpheusNetwork(0), /unsupported Neo network/);
  assert.throws(() => resolvePayloadNetwork({ network: false }), /unsupported Neo network/);
  assert.throws(() => resolvePayloadNetwork({ network: 0 }), /unsupported Neo network/);
});

test('worker N3 magic comes from the reviewed projection and rejects drift', () => {
  assert.equal(resolveReviewedNeoNetworkMagic('mainnet'), 860833102);
  assert.equal(resolveReviewedNeoNetworkMagic('testnet'), 894710606);
  assert.throws(
    () => resolveReviewedNeoNetworkMagic('mainnet', '894710606'),
    /conflicts with reviewed/
  );
});
