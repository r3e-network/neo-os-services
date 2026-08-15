import test from 'node:test';
import assert from 'node:assert/strict';

import { stableStringify } from './core.js';
import { stableStringify as sharedStableStringify } from '@r3e-network/neo-os-services-shared/utils';
import { STABLE_STRINGIFY_GOLDEN_VECTORS } from '../../../../packages/shared/src/stable-stringify-vectors.mjs';

// output_hash digests are computed from stableStringify output (chain/signing.js),
// so the worker-visible implementation must reproduce the golden vectors
// byte-for-byte: any drift silently breaks verification of signed envelopes.
test('worker stableStringify reproduces the golden output_hash vectors byte-for-byte', () => {
  for (const vector of STABLE_STRINGIFY_GOLDEN_VECTORS) {
    assert.equal(stableStringify(vector.input), vector.expected, vector.name);
  }
});

test('shared stableStringify matches the worker implementation on every golden vector', () => {
  for (const vector of STABLE_STRINGIFY_GOLDEN_VECTORS) {
    assert.equal(sharedStableStringify(vector.input), vector.expected, vector.name);
    assert.equal(sharedStableStringify(vector.input), stableStringify(vector.input), vector.name);
  }
});
