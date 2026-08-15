// Morpheus Oracle — host-side egress proxy for the Nitro enclave.
//
// The merged compute+sign enclave has NO network interface. Its in-enclave
// compute (the worker's price/RPC fetches via Node global fetch + neon-js
// cross-fetch) is configured with HTTPS_PROXY pointing at a local socat that
// forwards over vsock to THIS proxy on the parent instance. This is a strict
// HTTP CONNECT (HTTPS tunnel) forwarder with an ALLOW-LIST:
//
//   enclave fetch --HTTPS_PROXY--> 127.0.0.1:3128 (in-enclave socat)
//     --vsock CID3:8788--> host socat --> 127.0.0.1:13128 (THIS proxy)
//     --allow-list check--> net.connect(host:443) --> real provider
//
// The enclave performs END-TO-END TLS to the real hostname THROUGH the tunnel
// (it validates the provider's certificate with the image's bundled CA store), so
// this proxy only ever sees the CONNECT target (host:port, for the allow-list)
// and then OPAQUE TLS ciphertext — it cannot read or MITM the traffic.
//
// Plaintext HTTP (a bare GET/POST request, not CONNECT) is REFUSED: it would be
// MITM-able and is not part of the no-MITM egress contract.
//
// The allow-list is HOST-side config (this file reads vsock-proxy.allowlist.yaml),
// NOT baked into the measured enclave image — so it can be tuned operationally
// without changing the enclave PCRs. Denied destinations are logged so a missing
// provider surfaces immediately during validation.

import http from 'node:http';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROXY_HOST = '127.0.0.1';
const PROXY_PORT = Math.max(Number(process.env.ENCLAVE_EGRESS_PROXY_PORT) || 13128, 1);
const ALLOWLIST_PATH =
  (process.env.ENCLAVE_EGRESS_ALLOWLIST || '').trim() ||
  join(__dirname, 'vsock-proxy.allowlist.yaml');
// Upstream dial + idle timeouts (ms). A wedged upstream must not pin a fd.
const CONNECT_TIMEOUT_MS = Math.max(
  Number(process.env.ENCLAVE_EGRESS_CONNECT_TIMEOUT_MS) || 10_000,
  1000
);
const IDLE_TIMEOUT_MS = Math.max(
  Number(process.env.ENCLAVE_EGRESS_IDLE_TIMEOUT_MS) || 120_000,
  5000
);

function log(level, event, data = {}) {
  process.stdout.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      runtime: 'morpheus-egress-proxy',
      event,
      ...data,
    }) + '\n'
  );
}

// Parse the YAML allow-list WITHOUT a yaml dependency. The committed format is a
// flat list of `- {address: host, port: n}` entries under `allowlist:`; we match
// exactly those lines and ignore comments/blank lines. We fail CLOSED: an
// unreadable/empty allow-list yields an empty set (every CONNECT denied) rather
// than silently allowing everything.
export function loadAllowlist(path) {
  const allowed = new Set();
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    log('error', 'allowlist_unreadable', { path, error: error.message });
    return allowed;
  }
  const entryRe = /-\s*\{\s*address:\s*["']?([A-Za-z0-9._-]+)["']?\s*,\s*port:\s*(\d{1,5})\s*\}/;
  for (let line of raw.split(/\r?\n/)) {
    // Strip any comment first so a commented-out entry is never parsed (hostnames
    // and ports never contain '#').
    const hash = line.indexOf('#');
    if (hash !== -1) line = line.slice(0, hash);
    const match = entryRe.exec(line);
    if (!match) continue;
    const host = match[1].toLowerCase();
    const port = Number(match[2]);
    if (host && port > 0 && port <= 65535) allowed.add(`${host}:${port}`);
  }
  return allowed;
}

// CONNECT target "host:port" -> {host, port} (default port 443).
export function parseTarget(rawTarget) {
  const target = String(rawTarget || '').trim();
  const lastColon = target.lastIndexOf(':');
  if (lastColon <= 0) return { host: target.toLowerCase(), port: 443 };
  const host = target.slice(0, lastColon).toLowerCase();
  const port = Number(target.slice(lastColon + 1));
  return { host, port: Number.isFinite(port) && port > 0 ? port : 443 };
}

// Build the proxy server from a resolved allow-list Set ("host:port" entries).
// Exported (with no auto-listen) so the security behavior is unit-testable.
export function createProxyServer({
  allowlist,
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
  idleTimeoutMs = IDLE_TIMEOUT_MS,
} = {}) {
  const allowed = allowlist instanceof Set ? allowlist : new Set(allowlist || []);

  const server = http.createServer((req, res) => {
    // A non-CONNECT request means someone tried plaintext HTTP through the proxy.
    // Refuse it — only TLS tunnels (CONNECT) are permitted (no-MITM contract).
    res.writeHead(405, { 'content-type': 'application/json', connection: 'close' });
    res.end(JSON.stringify({ error: 'only HTTPS CONNECT tunneling is permitted' }));
  });

  server.on('connect', (req, clientSocket, head) => {
    const { host, port } = parseTarget(req.url);
    const key = `${host}:${port}`;

    clientSocket.on('error', () => {});

    if (!allowed.has(key)) {
      log('warn', 'egress_denied', { host, port });
      clientSocket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    const upstream = net.connect({ host, port });
    let settled = false;
    const connectTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        log('warn', 'egress_connect_timeout', { host, port });
        try {
          clientSocket.write('HTTP/1.1 504 Gateway Timeout\r\nConnection: close\r\n\r\n');
        } catch {}
        upstream.destroy();
        clientSocket.destroy();
      }
    }, connectTimeoutMs);

    upstream.on('connect', () => {
      settled = true;
      clearTimeout(connectTimer);
      log('info', 'egress_allowed', { host, port });
      clientSocket.write('HTTP/1.1 200 Connection established\r\nConnection: keep-alive\r\n\r\n');
      if (head && head.length) upstream.write(head);
      // Idle reaper: tear the tunnel down if both ends go quiet (prevents fd leaks).
      clientSocket.setTimeout(idleTimeoutMs);
      upstream.setTimeout(idleTimeoutMs);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });

    const teardown = () => {
      clearTimeout(connectTimer);
      upstream.destroy();
      clientSocket.destroy();
    };
    upstream.on('error', (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(connectTimer);
        log('warn', 'egress_upstream_error', { host, port, error: error.message });
        try {
          clientSocket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
        } catch {}
      }
      upstream.destroy();
      clientSocket.destroy();
    });
    upstream.on('timeout', teardown);
    clientSocket.on('timeout', teardown);
    upstream.on('close', () => clientSocket.destroy());
    clientSocket.on('close', () => upstream.destroy());
  });

  server.on('clientError', (err, socket) => {
    try {
      socket.destroy();
    } catch {}
  });

  return server;
}

// Run as the main module only (never when imported by the test).
const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (isMain) {
  const allowlist = loadAllowlist(ALLOWLIST_PATH);
  if (!allowlist.size) {
    log('error', 'empty_allowlist_fail_closed', { path: ALLOWLIST_PATH });
  } else {
    log('info', 'allowlist_loaded', {
      path: ALLOWLIST_PATH,
      count: allowlist.size,
      hosts: [...allowlist].sort(),
    });
  }
  createProxyServer({ allowlist }).listen(PROXY_PORT, PROXY_HOST, () => {
    log('info', 'listening', {
      host: PROXY_HOST,
      port: PROXY_PORT,
      allowlist_count: allowlist.size,
    });
  });
}
