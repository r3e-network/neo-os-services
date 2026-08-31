import test from 'node:test';
import assert from 'node:assert/strict';

import { resolvePinnedAddresses } from './ssrf.js';

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
