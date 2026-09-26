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
    'https://10.0.0.5:10332',
    'https://192.168.1.10',
    'https://172.16.0.1',
    'https://127.0.0.1',
    'https://169.254.10.20', // full link-local range, not just 169.254.169.254
    'https://169.254.169.254', // cloud metadata
    'https://100.64.0.1', // CGNAT
    'https://0.0.0.0',
    'https://224.0.0.1', // multicast
  ]) {
    await assert.rejects(validateRpcUrl(url), /private\/internal RPC URLs not allowed/, url);
  }
});

test('validateRpcUrl blocks IPv6 loopback / ULA / link-local literals', async () => {
  for (const url of [
    'https://[::1]', // loopback
    'https://[fc00::1]', // ULA fc00::/7
    'https://[fd12:3456:789a::1]', // ULA
    'https://[fe80::1]', // link-local
    'https://[::ffff:127.0.0.1]', // IPv4-mapped loopback
    'https://[::ffff:169.254.169.254]', // IPv4-mapped metadata
  ]) {
    await assert.rejects(validateRpcUrl(url), /private\/internal RPC URLs not allowed/, url);
  }
});

test('validateRpcUrl blocks localhost / *.local / 0.0.0.0 hostnames', async () => {
  for (const url of ['https://localhost:10332', 'https://foo.local', 'https://0.0.0.0']) {
    await assert.rejects(validateRpcUrl(url), /private\/internal RPC URLs not allowed/, url);
  }
});

test('validateRpcUrl rejects non-http(s) schemes', async () => {
  await assert.rejects(validateRpcUrl('ftp://example.com'), /must use HTTPS/);
  await assert.rejects(validateRpcUrl('file:///etc/passwd'), /must use HTTPS/);
});

test('validateRpcUrl rejects cleartext public RPC endpoints', async () => {
  await assert.rejects(validateRpcUrl('http://8.8.8.8'), /must use HTTPS/);
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
