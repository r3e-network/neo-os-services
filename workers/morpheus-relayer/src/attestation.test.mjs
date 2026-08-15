import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createHash } from 'node:crypto';

// Import directly from the NEW module to lock the extraction boundary: these
// symbols must resolve from ./attestation.js (not only via the ./fulfillment.js
// re-export). The full behavioral matrix lives in fulfillment.test.mjs; this file
// re-asserts a couple of the load-bearing behaviors against the module under test.
import { resolveExpectedPcr0, verifyEnclaveAttestation } from './attestation.js';

// Minimal CBOR encoder (mirrors the enclave's) used to build a real COSE_Sign1
// attestation document the relayer's verifier parses.
function cborEncodeForTest(value) {
  const head = (major, n) => {
    const big = BigInt(n);
    if (big < 24n) return Buffer.from([(major << 5) | Number(big)]);
    if (big < 256n) return Buffer.from([(major << 5) | 24, Number(big)]);
    if (big < 65536n)
      return Buffer.from([(major << 5) | 25, Number(big >> 8n) & 0xff, Number(big) & 0xff]);
    const b = Buffer.alloc(5);
    b[0] = (major << 5) | 26;
    b.writeUInt32BE(Number(big), 1);
    return b;
  };
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return head(0, value);
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (typeof value === 'string') {
    const b = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, b.length), b]);
  }
  if (Array.isArray(value))
    return Buffer.concat([head(4, value.length), ...value.map(cborEncodeForTest)]);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    const parts = [head(5, entries.length)];
    for (const [k, v] of entries) {
      parts.push(/^\d+$/.test(k) ? cborEncodeForTest(Number(k)) : cborEncodeForTest(k));
      parts.push(cborEncodeForTest(v));
    }
    return Buffer.concat(parts);
  }
  throw new Error(`cborEncodeForTest: unsupported ${typeof value}`);
}

function buildAttestationDoc({ userDataHex, pcr0Hex }) {
  const payload = {
    pcrs: { 0: Buffer.from(pcr0Hex, 'hex'), 1: Buffer.alloc(48, 1) },
    user_data: Buffer.from(userDataHex, 'hex'),
  };
  const cose = [Buffer.from([0xa0]), {}, cborEncodeForTest(payload), Buffer.alloc(96, 7)];
  return cborEncodeForTest(cose).toString('base64');
}

describe('attestation module boundary (imported from ./attestation.js)', () => {
  const DIGEST = 'ab'.repeat(32);
  const PCR0 = 'cd'.repeat(48);
  const userDataFor = (digestHex) =>
    createHash('sha256').update(Buffer.from(digestHex, 'hex')).digest('hex');

  it('a missing attestation document downgrades (not attested, no throw)', () => {
    const res = verifyEnclaveAttestation({}, { signature: 'a'.repeat(128) }, DIGEST);
    assert.equal(res.attested, false);
    assert.match(res.reason, /no attestation document/);
  });

  it('a document binding the WRONG digest is rejected (hard throw)', () => {
    const doc = buildAttestationDoc({ userDataHex: userDataFor('11'.repeat(32)), pcr0Hex: PCR0 });
    assert.throws(
      () => verifyEnclaveAttestation({}, { attestation_doc_base64: doc }, DIGEST),
      /does not bind the fulfillment digest/
    );
  });

  it('never trusts an unsigned payload, even when digest and pinned PCR0 match', () => {
    const doc = buildAttestationDoc({ userDataHex: userDataFor(DIGEST), pcr0Hex: PCR0 });

    const downgraded = verifyEnclaveAttestation({}, { attestation_doc_base64: doc }, DIGEST);
    assert.equal(downgraded.attested, false);
    assert.match(downgraded.reason, /no MORPHEUS_EXPECTED_PCR0 pinned/);
    assert.equal(downgraded.pcr0, PCR0);

    const unsigned = verifyEnclaveAttestation(
      { nitro: { expectedPcr0: PCR0 } },
      { attestation_doc_base64: doc },
      DIGEST
    );
    assert.equal(unsigned.attested, false);
    assert.equal(unsigned.pcr0, PCR0);
    assert.equal(unsigned.cose_verified, false);
    assert.match(unsigned.reason, /signature\/certificate chain was not verified/);
  });

  it('resolveExpectedPcr0 normalizes (lowercase, no 0x)', () => {
    assert.equal(resolveExpectedPcr0({ nitro: { expectedPcr0: '0xABcd' } }), 'abcd');
  });
});
