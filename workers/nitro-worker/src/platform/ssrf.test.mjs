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
  await assert.rejects(
    resolvePinnedAddresses('morpheus-oracle-unresolved.invalid', { allowUnresolved: false }),
    /unable to resolve host/i
  );
});
