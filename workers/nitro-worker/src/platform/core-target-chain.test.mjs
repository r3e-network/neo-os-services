import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTargetChain, SUPPORTED_ORACLE_TARGET_CHAINS } from './core.js';

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
