import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  AWS_NITRO_ROOT_FINGERPRINTS_SHA256,
  AWS_NITRO_ROOT_G1_PEM,
  assertPinnedNitroRootPem,
  certificateFingerprintSha256,
  splitPemCertificates,
} from './nitro-root.js';

const repoFile = (relative) =>
  readFileSync(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)), 'utf8');

// A real, well-formed, self-signed P-384 certificate that is NOT the AWS Nitro
// root. Stands in for "a root the host operator controls" — the exact anchor
// substitution CL-01 requires the verifier to reject.
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

test('the inlined root hashes to the pinned AWS Nitro G1 fingerprint', () => {
  const cert = new X509Certificate(AWS_NITRO_ROOT_G1_PEM);
  assert.equal(
    certificateFingerprintSha256(cert.raw),
    '641a0321a3e244efe456463195d606317ed7cdcc3c1756e09893f3c68f79bb5b'
  );
  assert.ok(AWS_NITRO_ROOT_FINGERPRINTS_SHA256.includes(certificateFingerprintSha256(cert.raw)));
  assert.equal(cert.subject, cert.issuer, 'the pinned anchor must be self-signed');
});

test('the inlined root does not drift from the other pinned copies in the repo', () => {
  const canonical = repoFile('apps/web/lib/attestation/aws-nitro-root.pem');
  const canonicalDer = new X509Certificate(canonical).raw;
  const inlinedDer = new X509Certificate(AWS_NITRO_ROOT_G1_PEM).raw;
  assert.ok(canonicalDer.equals(inlinedDer), 'apps/web/lib/attestation/aws-nitro-root.pem drifted');

  for (const path of [
    'apps/web/lib/nitro-attestation.ts',
    'deploy/custody-state-authority/src/attestation.mjs',
  ]) {
    const [block] = splitPemCertificates(repoFile(path));
    assert.ok(block, `${path} no longer inlines an AWS Nitro root PEM`);
    assert.ok(new X509Certificate(block).raw.equals(inlinedDer), `${path} drifted`);
  }
});

test('assertPinnedNitroRootPem accepts the pinned root and returns it unchanged', () => {
  assert.equal(assertPinnedNitroRootPem(AWS_NITRO_ROOT_G1_PEM), AWS_NITRO_ROOT_G1_PEM);
});

test('assertPinnedNitroRootPem rejects a well-formed root that is not the AWS root', () => {
  assert.throws(
    () => assertPinnedNitroRootPem(ROGUE_ROOT_PEM, { source: 'MORPHEUS_NITRO_ROOT_CERT_PEM' }),
    /MORPHEUS_NITRO_ROOT_CERT_PEM: DER SHA-256 48ee6ae3.* is not a pinned AWS Nitro Enclaves root/
  );
});

test('assertPinnedNitroRootPem rejects empty and malformed input', () => {
  assert.throws(() => assertPinnedNitroRootPem(''), /contains no PEM CERTIFICATE block/);
  assert.throws(() => assertPinnedNitroRootPem('PEM-A'), /contains no PEM CERTIFICATE block/);
  assert.throws(
    () =>
      assertPinnedNitroRootPem(
        '-----BEGIN CERTIFICATE-----\nMIIBfakeRootCert\n-----END CERTIFICATE-----'
      ),
    /certificate is malformed/
  );
});

test('a bundle is rejected when ANY block is not a pinned root', () => {
  assert.throws(
    () => assertPinnedNitroRootPem(`${AWS_NITRO_ROOT_G1_PEM}\n${ROGUE_ROOT_PEM}`),
    /is not a pinned AWS Nitro Enclaves root/
  );
});
