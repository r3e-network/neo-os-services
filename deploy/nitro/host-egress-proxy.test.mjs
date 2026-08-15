// Security gate for deploy/nitro/host-egress-proxy.mjs.
//
// Proves the host egress proxy: (1) tunnels an ALLOW-LISTED CONNECT target to the
// real upstream and pipes bytes both ways, (2) REFUSES a non-allow-listed target
// with 403 (no upstream connection), (3) refuses plaintext (non-CONNECT) with 405,
// (4) parses the allow-list YAML, (5) fails CLOSED on an empty/unreadable list.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createProxyServer, loadAllowlist, parseTarget } from './host-egress-proxy.mjs';

function listen(server, host = '127.0.0.1') {
  return new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)));
}

// Issue a raw CONNECT through the proxy; resolve with the status line + (optional)
// the bytes the upstream echoed back after the tunnel is established.
function connectThroughProxy(proxyPort, target, { sendAfter = '' } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, '127.0.0.1', () => {
      sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    let buf = Buffer.alloc(0);
    let statusLine = '';
    let tunneled = '';
    const timer = setTimeout(() => {
      sock.destroy();
      resolve({ statusLine, tunneled });
    }, 1500);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const headerEnd = buf.indexOf('\r\n\r\n');
      if (!statusLine && headerEnd !== -1) {
        statusLine = buf.subarray(0, buf.indexOf('\r\n')).toString();
        const established = /\s200\s/.test(statusLine);
        buf = buf.subarray(headerEnd + 4);
        if (established && sendAfter) sock.write(sendAfter);
        if (!established) {
          clearTimeout(timer);
          sock.destroy();
          resolve({ statusLine, tunneled });
          return;
        }
      }
      if (statusLine && /\s200\s/.test(statusLine)) {
        tunneled += buf.toString();
        buf = Buffer.alloc(0);
        if (tunneled.length) {
          clearTimeout(timer);
          sock.destroy();
          resolve({ statusLine, tunneled });
        }
      }
    });
    sock.on('error', reject);
  });
}

test('allow-listed CONNECT tunnels to the upstream and pipes bytes', async () => {
  // Fake upstream that echoes "PONG" once it receives anything.
  const upstream = net.createServer((s) => s.on('data', () => s.write('PONG')));
  const upPort = await listen(upstream);
  const proxy = createProxyServer({ allowlist: new Set([`127.0.0.1:${upPort}`]) });
  const proxyPort = await listen(proxy);

  const { statusLine, tunneled } = await connectThroughProxy(proxyPort, `127.0.0.1:${upPort}`, {
    sendAfter: 'PING',
  });
  assert.match(statusLine, /200/);
  assert.equal(tunneled, 'PONG');
  upstream.close();
  proxy.close();
});

test('non-allow-listed CONNECT is refused with 403 (no upstream dial)', async () => {
  let upstreamHit = false;
  const upstream = net.createServer(() => {
    upstreamHit = true;
  });
  const upPort = await listen(upstream);
  // Allow a DIFFERENT port so the requested target is not on the list.
  const proxy = createProxyServer({ allowlist: new Set([`127.0.0.1:${upPort + 1}`]) });
  const proxyPort = await listen(proxy);

  const { statusLine } = await connectThroughProxy(proxyPort, `127.0.0.1:${upPort}`);
  assert.match(statusLine, /403/);
  assert.equal(upstreamHit, false, 'denied target must never reach the upstream');
  upstream.close();
  proxy.close();
});

test('plaintext (non-CONNECT) request is refused with 405', async () => {
  const proxy = createProxyServer({ allowlist: new Set(['example.com:443']) });
  const proxyPort = await listen(proxy);
  const status = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: proxyPort, path: 'http://example.com/' }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
  });
  assert.equal(status, 405);
  proxy.close();
});

test('loadAllowlist parses the committed YAML format and fails closed when empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'egress-allow-'));
  const file = join(dir, 'allow.yaml');
  writeFileSync(
    file,
    [
      'allowlist:',
      '  - {address: api.twelvedata.com, port: 443}   # comment',
      '  - {address: api1.binance.com, port: 443}',
      '  # commented-out: - {address: evil.example.com, port: 443}',
    ].join('\n')
  );
  const set = loadAllowlist(file);
  assert.equal(set.has('api.twelvedata.com:443'), true);
  assert.equal(set.has('api1.binance.com:443'), true);
  assert.equal(set.size, 2, 'commented entries are not parsed');

  // Unreadable path -> empty set (fail closed).
  assert.equal(loadAllowlist(join(dir, 'does-not-exist.yaml')).size, 0);
});

test('parseTarget defaults the port to 443', () => {
  assert.deepEqual(parseTarget('api.coinbase.com:443'), { host: 'api.coinbase.com', port: 443 });
  assert.deepEqual(parseTarget('api.coinbase.com'), { host: 'api.coinbase.com', port: 443 });
});

test('the committed production allow-list parses and includes the core providers', () => {
  const set = loadAllowlist(new URL('./vsock-proxy.allowlist.yaml', import.meta.url).pathname);
  assert.ok(set.size >= 10, 'production allow-list should have the full provider set');
  for (const host of ['api.twelvedata.com:443', 'api1.binance.com:443', 'api.coinbase.com:443']) {
    assert.equal(set.has(host), true, `${host} must be allow-listed`);
  }
});
