import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

test('the production workspace has no RustCrypto rsa package', () => {
  const lockfile = readFileSync(join(process.cwd(), 'Cargo.lock'), 'utf8');
  assert.doesNotMatch(
    lockfile,
    /^name = "rsa"$/mu,
    'production RSA private operations must use the reviewed provider'
  );
});

test('secret releases, CMS parameters, and legacy RS256 bounds stay hardened', () => {
  const read = (relative) => readFileSync(join(process.cwd(), relative), 'utf8');
  const release = read('crates/nitro-attest/src/release.rs');
  const cms = read('crates/nitro-attest/src/cms.rs');
  const neodid = read('workers/nitro-enclave-host/src/neodid.rs');
  const hostState = read('workers/nitro-enclave-host/src/state.rs');

  assert.match(release, /AttestResult<Zeroizing<Vec<u8>>>/);
  assert.match(release, /AttestResult<Zeroizing<\[u8; 32\]>>/);
  assert.match(cms, /validate_rsa_oaep_sha256_parameters/);
  assert.match(cms, /oid_mgf1/);
  assert.match(cms, /pSourceAlgorithm label must be empty/);
  assert.match(neodid, /RSA_PKCS1_1024_8192_SHA256_FOR_LEGACY_USE_ONLY/);
  assert.match(hostState, /Result<Zeroizing<Vec<u8>>, String>/);
});
