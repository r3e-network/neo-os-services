import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { env, ensureBuffer, sha256Hex } from './node-runtime.js';

test('env returns the first non-empty process.env value among the given names', () => {
  process.env.MORPHEUS_SHARED_NODE_RUNTIME_TEST_A = '';
  process.env.MORPHEUS_SHARED_NODE_RUNTIME_TEST_B = '  padded-value  ';
  try {
    assert.equal(
      env('MORPHEUS_SHARED_NODE_RUNTIME_TEST_A', 'MORPHEUS_SHARED_NODE_RUNTIME_TEST_B'),
      'padded-value'
    );
    assert.equal(env('MORPHEUS_SHARED_NODE_RUNTIME_TEST_MISSING'), '');
  } finally {
    delete process.env.MORPHEUS_SHARED_NODE_RUNTIME_TEST_A;
    delete process.env.MORPHEUS_SHARED_NODE_RUNTIME_TEST_B;
  }
});

test('sha256Hex hashes strings, buffers, and objects identically to node:crypto', () => {
  assert.equal(sha256Hex('hello'), createHash('sha256').update('hello', 'utf8').digest('hex'));
  assert.equal(
    sha256Hex(Buffer.from([1, 2, 3])),
    createHash('sha256')
      .update(Buffer.from([1, 2, 3]))
      .digest('hex')
  );
  // Objects hash their stableStringify form, matching the worker digest paths.
  assert.equal(
    sha256Hex({ b: 2, a: 1 }),
    createHash('sha256').update('{"a":1,"b":2}', 'utf8').digest('hex')
  );
});

test('ensureBuffer normalizes the supported input shapes', () => {
  assert.deepEqual(ensureBuffer('ab'), Buffer.from('ab', 'utf8'));
  assert.deepEqual(ensureBuffer(new Uint8Array([7])), Buffer.from([7]));
  assert.deepEqual(ensureBuffer(Buffer.from([9])), Buffer.from([9]));
  assert.deepEqual(ensureBuffer({ a: 1 }), Buffer.from('{"a":1}', 'utf8'));
});
