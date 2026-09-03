import test from 'node:test';
import assert from 'node:assert/strict';

import { handleVrf } from './vrf.js';
import {
  __resetCustodyTransportForTests,
  __setCustodyTransportForTests,
} from '../platform/custody.js';

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

const originalWorkerKeyId = process.env.SIGNER_ROLE_WORKER_KEY_ID;

test.before(() => {
  process.env.SIGNER_ROLE_WORKER_KEY_ID = 'test-worker-key';
  __setCustodyTransportForTests(async (method) =>
    method === 'GET'
      ? {
          key_id: 'test-worker-key',
          network: 'testnet',
          network_magic: 894710606,
          public_key: `02${'22'.repeat(32)}`,
          address: 'NTestWorkerCustodyAddress',
          script_hash: `0x${'33'.repeat(20)}`,
          signing_enabled: true,
        }
      : {
          allowed: true,
          signature: '11'.repeat(64),
          public_key: `02${'22'.repeat(32)}`,
          address: 'NTestWorkerCustodyAddress',
          script_hash: `0x${'33'.repeat(20)}`,
        }
  );
});

test.after(() => {
  if (originalWorkerKeyId === undefined) {
    delete process.env.SIGNER_ROLE_WORKER_KEY_ID;
  } else {
    process.env.SIGNER_ROLE_WORKER_KEY_ID = originalWorkerKeyId;
  }
  __resetCustodyTransportForTests();
});

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
