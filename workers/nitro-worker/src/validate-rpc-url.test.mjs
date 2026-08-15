import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveTrustedRpcUrl, validateRpcUrl } from './platform/core.js';
import { isBlockedIpAddress } from './platform/ssrf.js';

// Regression for the weak RPC SSRF check (audit finding 3): the old
// string-prefix guard missed IPv6 loopback/ULA/link-local, the full
// 169.254.0.0/16 range, 100.64/10 CGNAT, etc. validateRpcUrl now resolves the
// host through the shared SSRF classifier (assertResolvedHostAllowed), so it is
// async and rejects private/internal targets.

test('validateRpcUrl blocks private/internal IPv4 literals (incl. ranges the old check missed)', async () => {
  for (const url of [
    'http://10.0.0.5:10332',
    'http://192.168.1.10',
    'http://172.16.0.1',
    'http://127.0.0.1',
    'http://169.254.10.20', // full link-local range, not just 169.254.169.254
    'http://169.254.169.254', // cloud metadata
    'http://100.64.0.1', // CGNAT
    'http://0.0.0.0',
    'http://224.0.0.1', // multicast
  ]) {
    await assert.rejects(validateRpcUrl(url), /private\/internal RPC URLs not allowed/, url);
  }
});

test('validateRpcUrl blocks IPv6 loopback / ULA / link-local literals', async () => {
  for (const url of [
    'http://[::1]', // loopback
    'http://[fc00::1]', // ULA fc00::/7
    'http://[fd12:3456:789a::1]', // ULA
    'http://[fe80::1]', // link-local
    'http://[::ffff:127.0.0.1]', // IPv4-mapped loopback
    'http://[::ffff:169.254.169.254]', // IPv4-mapped metadata
  ]) {
    await assert.rejects(validateRpcUrl(url), /private\/internal RPC URLs not allowed/, url);
  }
});

test('validateRpcUrl blocks localhost / *.local / 0.0.0.0 hostnames', async () => {
  for (const url of ['http://localhost:10332', 'http://foo.local', 'http://0.0.0.0']) {
    await assert.rejects(validateRpcUrl(url), /private\/internal RPC URLs not allowed/, url);
  }
});

test('validateRpcUrl rejects non-http(s) schemes', async () => {
  await assert.rejects(validateRpcUrl('ftp://example.com'), /must use http or https/);
  await assert.rejects(validateRpcUrl('file:///etc/passwd'), /must use http or https/);
});

test('validateRpcUrl allows public RPC endpoints (hostnames and public IPs)', async () => {
  // Hostnames resolve via getaddrinfo; a public host (or an unresolvable one in a
  // network-less test env) is allowed. Public IP literals are allowed directly.
  assert.equal(
    await validateRpcUrl('https://api.n3index.dev/mainnet'),
    'https://api.n3index.dev/mainnet'
  );
  assert.equal(await validateRpcUrl('https://8.8.8.8'), 'https://8.8.8.8');
  // Empty input passes through unchanged (callers treat it as "use default").
  assert.equal(await validateRpcUrl(''), '');
});

test('resolveTrustedRpcUrl rejects a request-selected RPC origin', async () => {
  const previous = process.env.NEO_RPC_URL_TESTNET;
  process.env.NEO_RPC_URL_TESTNET = 'https://8.8.8.8';
  try {
    assert.equal(await resolveTrustedRpcUrl('testnet'), 'https://8.8.8.8');
    assert.equal(await resolveTrustedRpcUrl('testnet', 'https://8.8.8.8'), 'https://8.8.8.8');
    await assert.rejects(
      resolveTrustedRpcUrl('testnet', 'https://attacker-rpc.example'),
      /caller-supplied RPC URLs are not allowed/
    );
  } finally {
    if (previous === undefined) delete process.env.NEO_RPC_URL_TESTNET;
    else process.env.NEO_RPC_URL_TESTNET = previous;
  }
});

test('shared isBlockedIpAddress classifier covers the key ranges', () => {
  for (const addr of ['127.0.0.1', '169.254.169.254', 'fc00::1', 'fe80::1', '::1', '100.64.0.1']) {
    assert.equal(isBlockedIpAddress(addr), true, addr);
  }
  for (const addr of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
    assert.equal(isBlockedIpAddress(addr), false, addr);
  }
  // Non-IP / unparseable inputs are conservatively treated as blocked.
  assert.equal(isBlockedIpAddress('not-an-ip'), true);
});
