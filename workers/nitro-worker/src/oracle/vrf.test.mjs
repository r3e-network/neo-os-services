import test from 'node:test';
import assert from 'node:assert/strict';

import { handleVrf } from './vrf.js';

// D5 — every fulfillment lane must emit the canonical signed-result envelope.
// The VRF lane previously dropped `output_hash`; this pins it back in and keeps
// the lane-specific keys.

const CANONICAL_ENVELOPE_KEYS = [
  'output_hash',
  'signature',
  'public_key',
  'attestation_hash',
  'tee_attestation',
  'verification',
];

test('VRF response carries the canonical signed envelope including output_hash (D5)', async () => {
  const res = await handleVrf({});
  assert.equal(res.status, 200);
  const body = await res.json();

  for (const key of CANONICAL_ENVELOPE_KEYS) {
    assert.ok(key in body, `VRF envelope must include ${key}`);
  }
  // output_hash must be a 32-byte hex digest (sha256 of the signed result).
  assert.match(body.output_hash, /^[0-9a-f]{64}$/);
  // verification must mirror the top-level envelope.
  assert.equal(body.verification.output_hash, body.output_hash);
  assert.equal(body.verification.attestation_hash, body.attestation_hash);

  // Lane-specific fields are preserved (no regression).
  assert.match(body.randomness, /^[0-9a-f]{64}$/);
  assert.equal(body.vrf_method, 'csprng-signed');
  assert.ok(typeof body.request_id === 'string' && body.request_id.length > 0);
  assert.ok(Number.isFinite(body.timestamp));
});

test('VRF preserves a caller-supplied request_id (D5 additive, no key drop)', async () => {
  const res = await handleVrf({ request_id: 'req-d5-123' });
  const body = await res.json();
  assert.equal(body.request_id, 'req-d5-123');
  assert.ok('output_hash' in body);
});
