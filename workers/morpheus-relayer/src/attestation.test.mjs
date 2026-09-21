import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createHash, X509Certificate } from 'node:crypto';

// Import directly from the NEW module to lock the extraction boundary: these
// symbols must resolve from ./attestation.js (not only via the ./fulfillment.js
// re-export). The full behavioral matrix lives in fulfillment.test.mjs; this file
// re-asserts a couple of the load-bearing behaviors against the module under test.
import {
  enclaveSignatureVerificationEnabled,
  resolveExpectedPcr0,
  resolveNitroRootCertPem,
  verifyEnclaveAttestation,
} from './attestation.js';
import {
  AWS_NITRO_ROOT_G1_PEM,
  certificateFingerprintSha256,
} from '@r3e-network/neo-os-services-shared/nitro-root';

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

function buildAttestationDoc({ userDataHex, pcr0Hex, leafDer, cabundleDer }) {
  const payload = {
    pcrs: { 0: Buffer.from(pcr0Hex, 'hex'), 1: Buffer.alloc(48, 1) },
    user_data: Buffer.from(userDataHex, 'hex'),
  };
  if (leafDer) payload.certificate = leafDer;
  if (cabundleDer) payload.cabundle = cabundleDer;
  const cose = [Buffer.from([0xa0]), {}, cborEncodeForTest(payload), Buffer.alloc(96, 7)];
  return cborEncodeForTest(cose).toString('base64');
}

// A real, well-formed, self-signed P-384 certificate that is NOT the AWS Nitro
// root — i.e. exactly what a compromised host would put in
// MORPHEUS_NITRO_ROOT_CERT_PEM so its own forged documents chain to "a" root.
const ROGUE_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIICJzCCAa6gAwIBAgIUDgkVEwn19LXgQ7g3CikDoZyCxjIwCgYIKoZIzj0EAwIw
SzELMAkGA1UEBhMCVVMxDjAMBgNVBAoMBVJvZ3VlMQ0wCwYDVQQLDARUZXN0MR0w
GwYDVQQDDBRyb2d1ZS5uaXRyby1lbmNsYXZlczAeFw0yNjA5MjExNDI2MzlaFw0z
NjA5MTgxNDI2MzlaMEsxCzAJBgNVBAYTAlVTMQ4wDAYDVQQKDAVSb2d1ZTENMAsG
A1UECwwEVGVzdDEdMBsGA1UEAwwUcm9ndWUubml0cm8tZW5jbGF2ZXMwdjAQBgcq
hkjOPQIBBgUrgQQAIgNiAASf+UWblUfivzbCU6kuqqH7PJk7xiogWc/hzGDpTR0S
V7AnC4831wlOJse0ZoXt+uZdx1t9Qn3kMX0yP4oTc3zRitiRfdsMK4pN6202Ed0Q
2e8dSWImtCdNGqxPVPTfuw6jUzBRMB0GA1UdDgQWBBTL/7z4KMJVsTHmkjeVrA4Z
9RVVmDAfBgNVHSMEGDAWgBTL/7z4KMJVsTHmkjeVrA4Z9RVVmDAPBgNVHRMBAf8E
BTADAQH/MAoGCCqGSM49BAMCA2cAMGQCMChx+ghCYB4gEPluSZWWtri8T4APjP/D
Ol5dolD8aJCsemB+3fJeJFsqrJBmA9Ml+gIwKc2vleDDUsQYBLVRZa+FneJX/BdD
twiQoEvafSrQNyEzw9U8DQ5V0iBAFKCIO8/X
-----END CERTIFICATE-----`;

function withEnv(entries, run) {
  const saved = new Map();
  for (const [key, value] of Object.entries(entries)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ===================================================================
// SVC-A-4 (CL-01, CL-06) — the trust anchor is pinned in code, never
// taken on faith from the host, and "unset" must not mean "skip".
// ===================================================================
describe('nitro trust anchor is pinned, not host-supplied (SVC-A-4)', () => {
  const DIGEST = 'ab'.repeat(32);
  const PCR0 = 'cd'.repeat(48);
  const userDataFor = (digestHex) =>
    createHash('sha256').update(Buffer.from(digestHex, 'hex')).digest('hex');

  it('defaults to the built-in AWS Nitro root when nothing is configured', () => {
    withEnv({ MORPHEUS_NITRO_ROOT_CERT_PEM: undefined }, () => {
      const pem = resolveNitroRootCertPem({});
      assert.equal(pem, AWS_NITRO_ROOT_G1_PEM);
      assert.equal(
        certificateFingerprintSha256(new X509Certificate(pem).raw),
        '641a0321a3e244efe456463195d606317ed7cdcc3c1756e09893f3c68f79bb5b'
      );
    });
  });

  it('accepts a configured root only when it IS the pinned AWS Nitro root', () => {
    assert.equal(
      resolveNitroRootCertPem({ nitro: { nitroRootCertPem: AWS_NITRO_ROOT_G1_PEM } }),
      AWS_NITRO_ROOT_G1_PEM
    );
  });

  it('rejects a host-supplied root that is not the pinned AWS Nitro root (config)', () => {
    assert.throws(
      () => resolveNitroRootCertPem({ nitro: { nitroRootCertPem: ROGUE_ROOT_PEM } }),
      /is not a pinned AWS Nitro Enclaves root/
    );
  });

  it('rejects a host-supplied root that is not the pinned AWS Nitro root (env)', () => {
    withEnv({ MORPHEUS_NITRO_ROOT_CERT_PEM: ROGUE_ROOT_PEM }, () => {
      assert.throws(() => resolveNitroRootCertPem({}), /is not a pinned AWS Nitro Enclaves root/);
    });
  });

  it('a forged chain is a hard failure even with NOTHING configured', () => {
    // Before the fix an unconfigured anchor meant no signature/chain check at all,
    // so this document was merely "downgraded" instead of refused.
    const doc = buildAttestationDoc({
      userDataHex: userDataFor(DIGEST),
      pcr0Hex: PCR0,
      leafDer: new X509Certificate(ROGUE_ROOT_PEM).raw,
      cabundleDer: [new X509Certificate(ROGUE_ROOT_PEM).raw],
    });
    withEnv({ MORPHEUS_NITRO_ROOT_CERT_PEM: undefined }, () => {
      assert.throws(
        () =>
          verifyEnclaveAttestation(
            { nitro: { expectedPcr0: PCR0 } },
            { attestation_doc_base64: doc },
            DIGEST
          ),
        /does not verify to the pinned/
      );
    });
  });
});

// ===================================================================
// SVC-A-4 — enclave signature cross-check fails closed in production
// ===================================================================
describe('enclaveSignatureVerificationEnabled default (SVC-A-4)', () => {
  it('is ON by default under NODE_ENV=production', () => {
    withEnv(
      { NODE_ENV: 'production', MORPHEUS_RELAYER_VERIFY_ENCLAVE_SIGNATURE: undefined },
      () => {
        assert.equal(enclaveSignatureVerificationEnabled({}), true);
        assert.equal(enclaveSignatureVerificationEnabled({ nitro: {} }), true);
      }
    );
  });

  it('honors an explicit opt-out even in production', () => {
    withEnv({ NODE_ENV: 'production', MORPHEUS_RELAYER_VERIFY_ENCLAVE_SIGNATURE: 'false' }, () => {
      assert.equal(enclaveSignatureVerificationEnabled({}), false);
      assert.equal(
        enclaveSignatureVerificationEnabled({ nitro: { verifyEnclaveSignature: false } }),
        false
      );
    });
  });

  it('stays opt-in outside production, and config true still wins', () => {
    withEnv(
      { NODE_ENV: 'development', MORPHEUS_RELAYER_VERIFY_ENCLAVE_SIGNATURE: undefined },
      () => {
        assert.equal(enclaveSignatureVerificationEnabled({}), false);
        assert.equal(
          enclaveSignatureVerificationEnabled({ nitro: { verifyEnclaveSignature: true } }),
          true
        );
      }
    );
  });
});

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
