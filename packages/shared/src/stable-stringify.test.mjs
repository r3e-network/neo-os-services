import test from 'node:test';
import assert from 'node:assert/strict';

import { stableStringify } from './utils.js';
import { STABLE_STRINGIFY_GOLDEN_VECTORS } from './stable-stringify-vectors.mjs';

test('shared stableStringify reproduces the golden output_hash vectors byte-for-byte', () => {
  for (const vector of STABLE_STRINGIFY_GOLDEN_VECTORS) {
    assert.equal(stableStringify(vector.input), vector.expected, vector.name);
  }
});

test('shared stableStringify is deterministic across key insertion order', () => {
  const a = stableStringify({ outer: { z: 1, a: 2 }, list: [{ b: 1, a: 2 }] });
  const b = stableStringify({ list: [{ a: 2, b: 1 }], outer: { a: 2, z: 1 } });
  assert.equal(a, b);
});
