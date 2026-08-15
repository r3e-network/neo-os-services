/**
 * Fuzz tests for the oracle worker's security modules.
 *
 * Inlines the pure logic from:
 *   - src/platform/ssrf.js (IP classification)
 *   - src/platform/auth.js (safeEqual)
 *   - src/platform/nitro-signer.js (key derivation)
 *   - src/platform/permission-guard.js (allowlist validation)
 *
 * Run: cd /Users/jinghuiliao/git/neo-os/neo-os-services && node fuzz-security.mjs
 */

import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';

// ─── Inlined: ssrf.js logic ───────────────────────────────────────────────────

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isBlockedIpv4(address) {
  const octets = address.split('.').map((part) => Number.parseInt(part, 10));
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

function expandIpv6(address) {
  let value = address;
  const trailingV4 = value.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (trailingV4) {
    const parts = trailingV4[1].split('.').map((part) => Number.parseInt(part, 10));
    if (parts.length === 4 && parts.every((part) => part >= 0 && part <= 255)) {
      const hi = ((parts[0] << 8) | parts[1]).toString(16);
      const lo = ((parts[2] << 8) | parts[3]).toString(16);
      value = value.slice(0, trailingV4.index) + `${hi}:${lo}`;
    }
  }
  const [head, tail] = value.split('::');
  const headGroups = head ? head.split(':').filter(Boolean) : [];
  const tailGroups = tail !== undefined ? tail.split(':').filter(Boolean) : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  const groups =
    tail === undefined
      ? headGroups
      : [...headGroups, ...new Array(Math.max(missing, 0)).fill('0'), ...tailGroups];
  if (groups.length !== 8) return null;
  return groups.map((group) => Number.parseInt(group || '0', 16));
}

function isBlockedIpv6(address) {
  const groups = expandIpv6(address);
  if (!groups || groups.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)) {
    return true;
  }
  const isV4Mapped =
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    (groups[5] === 0 || groups[5] === 0xffff);
  const isNat64 = groups[0] === 0x64 && groups[1] === 0xff9b;
  if (isV4Mapped || isNat64) {
    const a = groups[6] >> 8;
    const b = groups[6] & 0xff;
    const c = groups[7] >> 8;
    const d = groups[7] & 0xff;
    if (groups[6] === 0 && groups[7] === 0) return true;
    return isBlockedIpv4(`${a}.${b}.${c}.${d}`);
  }
  const first = groups[0];
  return (
    groups.every((group) => group === 0) ||
    (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xffc0) === 0xfec0 ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xff00) === 0xff00
  );
}

function isBlockedIpAddress(rawAddress) {
  let address = trimString(rawAddress).toLowerCase();
  if (!address) return true;
  const zoneIndex = address.indexOf('%');
  if (zoneIndex !== -1) address = address.slice(0, zoneIndex);
  const family = isIP(address);
  if (family === 4) return isBlockedIpv4(address);
  if (family === 6) return isBlockedIpv6(address);
  return true;
}

// ─── Inlined: auth.js safeEqual ───────────────────────────────────────────────

function safeEqual(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// ─── Inlined: nitro-signer.js key derivation (pure SHA-256 HKDF-style) ───────

function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

function derive(master, path, purpose) {
  const material = Buffer.concat([
    Buffer.from(master),
    Buffer.from(`\x00${path}\x00${purpose}`, 'utf8'),
  ]);
  return Buffer.from(sha256Hex(material), 'hex');
}

// ─── Inlined: permission-guard.js allowlist validation ────────────────────────

function trimStringPerm(value) {
  return String(value || '').trim();
}

function isValidAllowNetEntry(entry) {
  if (!entry || entry.includes(' ')) return false;
  const host = entry.replace(/:\d+$/, '');
  if (!host) return false;
  if (host.includes('/')) return false;
  if (host.includes('*')) return false;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    return ipv4.slice(1).every((octet) => Number(octet) <= 255);
  }
  if (host.startsWith('[') && host.endsWith(']')) {
    return true;
  }
  if (host.includes(':') && !host.startsWith('[')) {
    return false;
  }
  const labels = host.split('.');
  if (labels.length < 1) return false;
  return labels.every((label) => /^[a-zA-Z0-9]([a-zA-Z0-9\-_]*[a-zA-Z0-9])?$/.test(label));
}

function parseAllowNet(raw) {
  const entries = trimStringPerm(raw)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const invalid = [];
  for (const entry of entries) {
    if (
      entry === '*' ||
      entry === '0.0.0.0/0' ||
      entry === '::/0' ||
      entry.startsWith('*.') ||
      !isValidAllowNetEntry(entry)
    ) {
      invalid.push(entry);
    }
  }
  return { entries, invalid };
}

// ─── Fuzz helpers ─────────────────────────────────────────────────────────────

function randInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function randOctet() {
  return randInt(0, 255);
}

function randIpv4() {
  return `${randOctet()}.${randOctet()}.${randOctet()}.${randOctet()}`;
}

function randHextet() {
  return randInt(0, 0xffff).toString(16);
}

function randString(len) {
  const chars =
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+-=[]{}|;:,.<>?/~`';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[randInt(0, chars.length - 1)];
  return s;
}

function randUtf8String(maxLen) {
  const pool = [
    ...'abcdefghijklmnopqrstuvwxyz0123456789',
    '\x00',
    '\x01',
    '\x7f',
    '\xff',
    '😀',
    '🚀',
    '🔥',
    '☃',
    '中',
    '文',
    'テ',
    'ス',
    'ト',
    '\u202e',
    '\u200b',
    '\ufeff',
  ];
  const len = randInt(0, maxLen);
  let s = '';
  for (let i = 0; i < len; i++) s += pool[randInt(0, pool.length - 1)];
  return s;
}

function formatIpv6FromBytes(buf) {
  // buf is 16 bytes -> format as full colon-hex IPv6
  const groups = [];
  for (let i = 0; i < 16; i += 2) {
    groups.push(((buf[i] << 8) | buf[i + 1]).toString(16));
  }
  return groups.join(':');
}

// ─── Test runner ──────────────────────────────────────────────────────────────

const results = [];

function report(suite, property, iterations, pass, counterexample) {
  results.push({ suite, property, iterations, pass, counterexample });
  const status = pass ? 'PASS' : 'FAIL';
  const ce = counterexample ? ` | counterexample: ${JSON.stringify(counterexample)}` : '';
  console.log(`  [${status}] ${property} (${iterations} iterations)${ce}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 1: SSRF IP Classification Fuzz (50,000 iterations)
// ═══════════════════════════════════════════════════════════════════════════════

function fuzzSsrf() {
  console.log('\n═══ Suite 1: SSRF IP Classification Fuzz ═══');
  const N = 50_000;

  // P1: Loopback always blocked
  {
    let fail = null;
    for (let i = 0; i < N && !fail; i++) {
      let ip;
      if (i % 2 === 0) {
        ip = `127.${randOctet()}.${randOctet()}.${randOctet()}`;
      } else {
        ip = '::1';
      }
      if (!isBlockedIpAddress(ip)) fail = ip;
    }
    report('SSRF', 'P1 Loopback always blocked', N, !fail, fail);
  }

  // P2: Private always blocked
  {
    let fail = null;
    for (let i = 0; i < N && !fail; i++) {
      let ip;
      const variant = i % 4;
      if (variant === 0) {
        ip = `10.${randOctet()}.${randOctet()}.${randOctet()}`;
      } else if (variant === 1) {
        ip = `172.${randInt(16, 31)}.${randOctet()}.${randOctet()}`;
      } else if (variant === 2) {
        ip = `192.168.${randOctet()}.${randOctet()}`;
      } else {
        // fc00::/7 -> first hextet in fc00..fdff
        const first = randInt(0xfc00, 0xfdff).toString(16);
        ip = `${first}:${randHextet()}:${randHextet()}:${randHextet()}:${randHextet()}:${randHextet()}:${randHextet()}:${randHextet()}`;
      }
      if (!isBlockedIpAddress(ip)) fail = ip;
    }
    report('SSRF', 'P2 Private always blocked', N, !fail, fail);
  }

  // P3: Link-local always blocked
  {
    let fail = null;
    for (let i = 0; i < N && !fail; i++) {
      let ip;
      if (i % 2 === 0) {
        ip = `169.254.${randOctet()}.${randOctet()}`;
      } else {
        // fe80::/10 -> first hextet in fe80..febf
        const first = randInt(0xfe80, 0xfebf).toString(16);
        ip = `${first}:${randHextet()}:${randHextet()}:${randHextet()}:${randHextet()}:${randHextet()}:${randHextet()}:${randHextet()}`;
      }
      if (!isBlockedIpAddress(ip)) fail = ip;
    }
    report('SSRF', 'P3 Link-local always blocked', N, !fail, fail);
  }

  // P4: Public never blocked
  {
    let fail = null;
    for (let i = 0; i < N && !fail; i++) {
      // Generate a random IPv4 that is NOT in any blocked range
      let a, b, c, d;
      do {
        a = randInt(1, 223); // avoid 0.x and multicast/reserved >=224
        b = randOctet();
        c = randOctet();
        d = randOctet();
      } while (
        a === 10 ||
        a === 127 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 169 && b === 254) ||
        (a === 100 && b >= 64 && b <= 127)
      );
      const ip = `${a}.${b}.${c}.${d}`;
      if (isBlockedIpAddress(ip)) fail = ip;
    }
    report('SSRF', 'P4 Public never blocked', N, !fail, fail);
  }

  // P5: IPv4-mapped consistency
  {
    let fail = null;
    for (let i = 0; i < N && !fail; i++) {
      const v4 = randIpv4();
      const mapped = `::ffff:${v4}`;
      const v4Result = isBlockedIpAddress(v4);
      const mappedResult = isBlockedIpAddress(mapped);
      if (v4Result !== mappedResult) fail = { v4, mapped, v4Result, mappedResult };
    }
    report('SSRF', 'P5 IPv4-mapped consistency', N, !fail, fail);
  }

  // P6: No crash on random 16-byte IPv6
  {
    let fail = null;
    for (let i = 0; i < N && !fail; i++) {
      const buf = randomBytes(16);
      const ip = formatIpv6FromBytes(buf);
      try {
        isBlockedIpAddress(ip);
      } catch (e) {
        fail = { ip, error: e.message };
      }
    }
    report('SSRF', 'P6 No crash (random 16-byte IPv6)', N, !fail, fail);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 2: Auth Token Comparison Fuzz (100,000 iterations)
// ═══════════════════════════════════════════════════════════════════════════════

function fuzzAuth() {
  console.log('\n═══ Suite 2: Auth Token Comparison Fuzz ═══');
  const N = 100_000;

  // P1: Identity - safeEqual(x, x) === true
  {
    let fail = null;
    for (let i = 0; i < N && !fail; i++) {
      const x = randString(randInt(1, 128));
      if (safeEqual(x, x) !== true) fail = x;
    }
    report('Auth', 'P1 Identity (safeEqual(x,x) === true)', N, !fail, fail);
  }

  // P2: Mismatch - safeEqual(x, y) === false when x !== y
  {
    let fail = null;
    for (let i = 0; i < N && !fail; i++) {
      const len = randInt(1, 64);
      const x = randString(len);
      let y = randString(len);
      // Ensure they differ
      if (x === y) y = y.slice(0, -1) + (y.endsWith('a') ? 'b' : 'a');
      if (safeEqual(x, y) !== false) fail = { x, y };
    }
    report('Auth', 'P2 Mismatch (x !== y => false)', N, !fail, fail);
  }

  // P3: Prefix attack - truncated token rejected
  {
    let fail = null;
    for (let i = 0; i < N && !fail; i++) {
      const token = randString(randInt(8, 128));
      const truncated = token.slice(0, -1);
      if (safeEqual(token, truncated) !== false) fail = { token, truncated };
    }
    report('Auth', 'P3 Prefix attack (truncated rejected)', N, !fail, fail);
  }

  // P4: Empty - safeEqual('', x) === false and safeEqual(x, '') === false
  {
    let fail = null;
    for (let i = 0; i < N && !fail; i++) {
      const x = randString(randInt(1, 64));
      if (safeEqual('', x) !== false) fail = { direction: 'empty-first', x };
      if (safeEqual(x, '') !== false) fail = { direction: 'empty-second', x };
    }
    report('Auth', 'P4 Empty string rejected', N, !fail, fail);
  }

  // P5: No throw on any random UTF-8 pair
  {
    let fail = null;
    for (let i = 0; i < N && !fail; i++) {
      const a = randUtf8String(randInt(0, 200));
      const b = randUtf8String(randInt(0, 200));
      try {
        safeEqual(a, b);
      } catch (e) {
        fail = { a: JSON.stringify(a), b: JSON.stringify(b), error: e.message };
      }
    }
    report('Auth', 'P5 No throw (random UTF-8 pairs)', N, !fail, fail);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 3: Key Derivation Fuzz (10,000 iterations)
// ═══════════════════════════════════════════════════════════════════════════════

function fuzzKeyDerivation() {
  console.log('\n═══ Suite 3: Key Derivation Fuzz ═══');
  const N = 10_000;

  // P1: Determinism
  {
    let fail = null;
    for (let i = 0; i < N && !fail; i++) {
      const master = randomBytes(32);
      const path = randString(randInt(1, 64));
      const purpose = randString(randInt(0, 32));
      const r1 = derive(master, path, purpose);
      const r2 = derive(master, path, purpose);
      if (!r1.equals(r2)) fail = { path, purpose };
    }
    report('KeyDeriv', 'P1 Determinism', N, !fail, fail);
  }

  // P2: Path sensitivity
  {
    let fail = null;
    for (let i = 0; i < N && !fail; i++) {
      const master = randomBytes(32);
      const path1 = randString(randInt(1, 64));
      let path2 = randString(randInt(1, 64));
      if (path1 === path2) path2 += 'x';
      const purpose = randString(randInt(0, 32));
      const r1 = derive(master, path1, purpose);
      const r2 = derive(master, path2, purpose);
      if (r1.equals(r2)) fail = { path1, path2, purpose };
    }
    report('KeyDeriv', 'P2 Path sensitivity', N, !fail, fail);
  }

  // P3: Purpose sensitivity
  {
    let fail = null;
    for (let i = 0; i < N && !fail; i++) {
      const master = randomBytes(32);
      const path = randString(randInt(1, 64));
      const p1 = randString(randInt(1, 32));
      let p2 = randString(randInt(1, 32));
      if (p1 === p2) p2 += 'y';
      const r1 = derive(master, path, p1);
      const r2 = derive(master, path, p2);
      if (r1.equals(r2)) fail = { path, p1, p2 };
    }
    report('KeyDeriv', 'P3 Purpose sensitivity', N, !fail, fail);
  }

  // P4: Master sensitivity
  {
    let fail = null;
    for (let i = 0; i < N && !fail; i++) {
      const m1 = randomBytes(32);
      let m2 = randomBytes(32);
      if (m1.equals(m2)) m2[0] ^= 0xff;
      const path = randString(randInt(1, 64));
      const purpose = randString(randInt(0, 32));
      const r1 = derive(m1, path, purpose);
      const r2 = derive(m2, path, purpose);
      if (r1.equals(r2)) fail = { path, purpose };
    }
    report('KeyDeriv', 'P4 Master sensitivity', N, !fail, fail);
  }

  // P5: Output length always 32 bytes
  {
    let fail = null;
    for (let i = 0; i < N && !fail; i++) {
      const master = randomBytes(randInt(16, 64));
      const path = randString(randInt(1, 128));
      const purpose = randString(randInt(0, 64));
      const out = derive(master, path, purpose);
      if (out.length !== 32) fail = { path, purpose, length: out.length };
    }
    report('KeyDeriv', 'P5 Output length === 32 bytes', N, !fail, fail);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 4: Permission Guard Allowlist Fuzz (10,000 iterations)
// ═══════════════════════════════════════════════════════════════════════════════

function fuzzPermissionGuard() {
  console.log('\n═══ Suite 4: Permission Guard Allowlist Fuzz ═══');
  const N = 10_000;

  // P1: Wildcard rejection - any entry containing '*' is rejected
  {
    let fail = null;
    // Exclude commas from generated strings since parseAllowNet splits on ','
    const noComma = (s) => s.replace(/,/g, 'x');
    for (let i = 0; i < N && !fail; i++) {
      const prefix = noComma(randString(randInt(0, 10)));
      const suffix = noComma(randString(randInt(0, 10)));
      const entry = `${prefix}*${suffix}`;
      const { invalid } = parseAllowNet(entry);
      if (!invalid.includes(entry)) fail = entry;
    }
    report('PermGuard', 'P1 Wildcard rejection', N, !fail, fail);
  }

  // P2: CIDR rejection - any entry containing '/' is rejected
  {
    let fail = null;
    for (let i = 0; i < N && !fail; i++) {
      const host = `${randOctet()}.${randOctet()}.${randOctet()}.${randOctet()}`;
      const cidr = `${host}/${randInt(0, 32)}`;
      const { invalid } = parseAllowNet(cidr);
      if (!invalid.includes(cidr)) fail = cidr;
    }
    report('PermGuard', 'P2 CIDR rejection', N, !fail, fail);
  }

  // P3: Valid pass-through - well-formed "host:port" entries accepted
  {
    let fail = null;
    const tlds = ['com', 'org', 'net', 'io', 'dev'];
    for (let i = 0; i < N && !fail; i++) {
      const label = randString(randInt(1, 20)).replace(/[^a-zA-Z0-9]/g, 'a') || 'a';
      const tld = tlds[randInt(0, tlds.length - 1)];
      const port = randInt(1, 65535);
      const entry = `${label}.${tld}:${port}`;
      const { invalid } = parseAllowNet(entry);
      if (invalid.includes(entry)) fail = entry;
    }
    report('PermGuard', 'P3 Valid host:port accepted', N, !fail, fail);
  }

  // P4: Empty rejection
  {
    let fail = null;
    for (let i = 0; i < N && !fail; i++) {
      // parseAllowNet('') should produce no valid entries
      const { entries } = parseAllowNet('');
      if (entries.length !== 0) fail = { entries };
      // Also test whitespace-only
      const ws = ' '.repeat(randInt(1, 10));
      const r2 = parseAllowNet(ws);
      if (r2.entries.length !== 0) fail = { input: ws, entries: r2.entries };
    }
    report('PermGuard', 'P4 Empty/whitespace rejection', N, !fail, fail);
  }

  // P5: No crash on random strings
  {
    let fail = null;
    for (let i = 0; i < N && !fail; i++) {
      const input = randUtf8String(randInt(0, 300));
      try {
        parseAllowNet(input);
      } catch (e) {
        fail = { input: JSON.stringify(input), error: e.message };
      }
    }
    report('PermGuard', 'P5 No crash (random strings)', N, !fail, fail);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║   Fuzz Security Tests - Oracle Worker Security Modules  ║');
console.log('╚══════════════════════════════════════════════════════════╝');

const start = performance.now();

fuzzSsrf();
fuzzAuth();
fuzzKeyDerivation();
fuzzPermissionGuard();

const elapsed = ((performance.now() - start) / 1000).toFixed(2);

console.log(`\n═══ Summary ═══`);
const total = results.length;
const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);
console.log(`  ${passed}/${total} properties passed in ${elapsed}s`);
if (failed.length > 0) {
  console.log('\n  FAILED PROPERTIES:');
  for (const f of failed) {
    console.log(`    - [${f.suite}] ${f.property}`);
    console.log(`      counterexample: ${JSON.stringify(f.counterexample)}`);
  }
  process.exit(1);
} else {
  console.log('  All properties held. No counterexamples found.');
}
