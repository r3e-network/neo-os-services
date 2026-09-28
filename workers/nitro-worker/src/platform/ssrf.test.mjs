import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { isBlockedIpAddress, resolvePinnedAddresses } from './ssrf.js';

// resolvePinnedAddresses backs both the SSRF host check and the oracle-fetch
// connection pinning (audit finding 8): it rejects private/internal hosts and
// returns the validated resolved addresses the fetch pins the socket to.

test('resolvePinnedAddresses rejects private/internal hosts (literals and names)', async () => {
  for (const host of [
    'localhost',
    '0.0.0.0',
    'foo.local',
    '127.0.0.1',
    '10.0.0.5',
    '192.168.1.10',
    '169.254.169.254', // cloud metadata
    '100.64.0.1', // CGNAT
    '::1', // IPv6 loopback
    'fc00::1', // ULA
    'fe80::1', // link-local
  ]) {
    await assert.rejects(resolvePinnedAddresses(host), /private\/internal URLs not allowed/, host);
  }
});

test('resolvePinnedAddresses returns no pin set for a public IP literal (connects directly)', async () => {
  // The connection already targets the literal IP, so there is nothing to pin.
  assert.deepEqual(await resolvePinnedAddresses('8.8.8.8'), []);
});

test('resolvePinnedAddresses returns validated {address,family} records for a public host', async () => {
  // Must never throw for a public host. In a network-less sandbox the lookup
  // fails and yields [] (lenient — the fetch fails on its own); when DNS is
  // available the resolved public addresses are returned for pinning.
  const result = await resolvePinnedAddresses('example.com');
  assert.ok(Array.isArray(result));
  for (const record of result) {
    assert.equal(typeof record.address, 'string');
    assert.ok(record.family === 4 || record.family === 6);
  }
});

test('resolvePinnedAddresses can fail closed when a caller must pin the connection', async () => {
  // Stub the DNS layer instead of relying on a name that "cannot" resolve:
  // on a developer machine running a fake-ip proxy (Clash et al.) every name,
  // including RFC 6761 .invalid, resolves to a synthetic address, so a live
  // lookup would succeed and the fail-closed branch would never run. ssrf.js
  // resolves `lookup` through node:dns/promises' default export (the mutable
  // CJS exports object — the ESM namespace itself is frozen), so swapping the
  // property there is observed by the already-imported module.
  const dns = (await import('node:dns/promises')).default;
  const originalLookup = dns.lookup;
  dns.lookup = async () => {
    throw Object.assign(new Error('getaddrinfo ENOTFOUND ssrf-unresolved.test'), {
      code: 'ENOTFOUND',
    });
  };
  try {
    await assert.rejects(
      resolvePinnedAddresses('ssrf-unresolved.test', { allowUnresolved: false }),
      /unable to resolve host/i
    );
  } finally {
    dns.lookup = originalLookup;
  }
});

// Shared JS/Rust classifier vectors: this file, the Rust compute port
// (crates/neo-os-compute/src/ssrf.rs) and the chain-n3 transport guard
// (crates/neo-os-chain-n3/src/ssrf.rs) all consume the same case list, so the
// three classifiers cannot drift apart on the ranges they must refuse.
const SHARED_VECTORS = JSON.parse(
  readFileSync(
    new URL('../../../../crates/neo-os-core/tests/vectors/ssrf_addresses.json', import.meta.url),
    'utf8'
  )
);

test('isBlockedIpAddress reproduces the shared JS/Rust vector file', () => {
  assert.ok(SHARED_VECTORS.cases.length >= 40);
  for (const vector of SHARED_VECTORS.cases) {
    assert.equal(
      isBlockedIpAddress(vector.address),
      vector.blocked,
      `${vector.name}: ${vector.address}`
    );
  }
});

test('isBlockedIpAddress classifies transition IPv6 on its embedded IPv4', () => {
  // FZ-16 reproducers: 6to4, Teredo and SIIT spellings of loopback, private,
  // link-local and metadata IPv4 must refuse even though the surrounding
  // hextets look public.
  for (const address of [
    '2002:7f00:1::1', // 6to4 -> 127.0.0.1
    '2002:a9fe:a9fe::1', // 6to4 -> 169.254.169.254
    '2002:a01:203::1', // 6to4 -> 10.1.2.3
    '2002::', // 6to4 bare prefix embeds 0.0.0.0
    '2001:0:4136:e378:8000:63bf:f5fe:fdfc', // Teredo client 10.1.2.3
    '2001:0:0:0:0:0:80ff:fffe', // Teredo client 127.0.0.1 (stored obfuscated)
    '2001:0::', // Teredo bare prefix: de-obfuscated client 255.255.255.255
    '::ffff:0:127.0.0.1', // SIIT form of loopback
  ]) {
    assert.equal(isBlockedIpAddress(address), true, address);
  }
  // Public embedded IPv4 stays allowed on every transition prefix.
  for (const address of [
    '2002:808:808::1', // 6to4 -> 8.8.8.8
    '2001:0:0:0:0:0:f7f7:f7f7', // Teredo client 8.8.8.8
  ]) {
    assert.equal(isBlockedIpAddress(address), false, address);
  }
});
