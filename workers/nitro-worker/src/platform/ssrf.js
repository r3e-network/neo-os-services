// Shared SSRF host classifier for the Nitro worker.
//
// String-prefix host checks are bypassable via DNS rebinding, octal/hex/decimal
// IPv4 literals, and IPv6 forms, so the hostname is resolved to concrete IPs and
// every address is range-checked. Both the oracle HTTP fetch path (oracle/fetch.js)
// and RPC URL validation (platform/core.js validateRpcUrl) use this single
// classifier so the same private/loopback/link-local/ULA ranges are blocked
// everywhere. This module is self-contained (no core.js import) to avoid an
// import cycle.

// Dereferenced at call time through the default export (the mutable CJS
// exports object) so tests can stub DNS without module-graph gymnastics.
import dnsPromises from 'node:dns/promises';
import { isIP } from 'node:net';

const dnsLookup = (...args) => dnsPromises.lookup(...args);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Returns true when an IP literal must be rejected (private/loopback/link-local/
// CGNAT/multicast/reserved, plus IPv4-mapped/6to4/Teredo/NAT64-tunnelled
// equivalents, and all of NAT64 64:ff9b::/32 outside the well-known /96).
export function isBlockedIpAddress(rawAddress) {
  let address = trimString(rawAddress).toLowerCase();
  if (!address) return true;
  // Strip an IPv6 zone identifier (e.g. fe80::1%eth0) before classification.
  const zoneIndex = address.indexOf('%');
  if (zoneIndex !== -1) address = address.slice(0, zoneIndex);

  const family = isIP(address);
  if (family === 4) return isBlockedIpv4(address);
  if (family === 6) return isBlockedIpv6(address);
  // Not a parseable IP literal: treat as unsafe rather than guessing.
  return true;
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
    a === 0 || // "this" network / 0.0.0.0
    a === 127 || // loopback 127.0.0.0/8
    a === 10 || // private 10.0.0.0/8
    (a === 172 && b >= 16 && b <= 31) || // private 172.16.0.0/12
    (a === 192 && b === 168) || // private 192.168.0.0/16
    (a === 169 && b === 254) || // link-local 169.254.0.0/16 (incl. cloud metadata)
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64.0.0/10
    a >= 224 // multicast 224.0.0.0/4 + reserved 240.0.0.0/4 + 255.255.255.255
  );
}

// Expands a (node:net-validated) IPv6 literal into 8 numeric hextets, decoding
// any trailing dotted-decimal IPv4 (e.g. ::ffff:127.0.0.1) into two hextets.
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

// Dotted-quad text of the IPv4 carried in two hextets (high, low).
function ipv4FromHextets(hi, lo) {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

function isBlockedIpv6(address) {
  const groups = expandIpv6(address);
  if (!groups || groups.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)) {
    return true;
  }
  // The /96 tunnel prefixes carry an IPv4 in the low 32 bits: IPv4-compatible
  // (::/96), IPv4-mapped (::ffff:0:0/96), SIIT IPv4-translated
  // (::ffff:0:0:0/96) and the NAT64 well-known prefix (64:ff9b::/96).
  // Classify on the embedded IPv4.
  const zeroHead = groups[0] === 0 && groups[1] === 0 && groups[2] === 0;
  const isV4Tunnelled =
    (zeroHead && groups[3] === 0 && groups[4] === 0 && (groups[5] === 0 || groups[5] === 0xffff)) ||
    (zeroHead && groups[3] === 0 && groups[4] === 0xffff && groups[5] === 0);
  const isNat64 = groups[0] === 0x64 && groups[1] === 0xff9b;
  const isNat64WellKnown =
    isNat64 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0;
  // The rest of 64:ff9b::/32 has no fixed IPv4 position: the RFC 8215
  // local-use prefix 64:ff9b:1::/48 may use any RFC 6052 layout (/48, /56,
  // /64 or /96) and may carry non-global IPv4. Refuse it outright.
  if (isNat64 && !isNat64WellKnown) return true;
  if (isV4Tunnelled || isNat64WellKnown) {
    // Bare ::ffff:0:0 / :: with no embedded host is itself unroutable.
    if (groups[6] === 0 && groups[7] === 0) return true;
    return isBlockedIpv4(ipv4FromHextets(groups[6], groups[7]));
  }
  // 6to4 (2002::/16) embeds an IPv4 in hextets 1-2. Teredo (2001:0::/32)
  // embeds two: the server IPv4 in hextets 2-3, where a Teredo relay or
  // client sends its indirect bubble (UDP 3544), and the client IPv4,
  // obfuscated (XOR 0xffffffff), in hextets 6-7. A transition translator on
  // the egress path sends traffic to those embedded IPv4, so each is
  // classified with the IPv4 rules and any blocked one refuses the address.
  if (groups[0] === 0x2002) {
    return isBlockedIpv4(ipv4FromHextets(groups[1], groups[2]));
  }
  if (groups[0] === 0x2001 && groups[1] === 0) {
    return (
      isBlockedIpv4(ipv4FromHextets(groups[2], groups[3])) ||
      isBlockedIpv4(ipv4FromHextets(groups[6] ^ 0xffff, groups[7] ^ 0xffff))
    );
  }
  const first = groups[0];
  return (
    groups.every((group) => group === 0) || // :: unspecified
    (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) || // ::1 loopback
    (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (first & 0xffc0) === 0xfec0 || // deprecated site-local fec0::/10
    (first & 0xfe00) === 0xfc00 || // unique local address (ULA) fc00::/7
    (first & 0xff00) === 0xff00 // multicast ff00::/8
  );
}

// Resolve + validate a hostname and return the validated resolved addresses so
// the caller can PIN the outbound connection to them — closing the DNS-rebinding
// window between this check and the actual connect (audit finding 8). Rejects
// when the literal host or any resolved address falls inside a
// private/loopback/link-local/ULA range. Returns:
//   - [] for an IP-literal host (the connection already targets that literal IP,
//     so there is nothing to rebind / pin), and
//   - [] when resolution fails by default (lenient: the host could not be
//     connected to either, so the fetch fails on its own and we avoid coupling
//     validation-only callers to transient DNS availability). Callers that must
//     pin the actual connection can pass allowUnresolved=false to fail closed.
export async function resolvePinnedAddresses(hostname, { allowUnresolved = true } = {}) {
  const host = trimString(hostname).toLowerCase();
  const literalHost = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

  if (host === 'localhost' || host === '0.0.0.0' || host.endsWith('.local')) {
    throw new Error('private/internal URLs not allowed');
  }

  // Reject IP literals (octal/hex/decimal IPv4, IPv6) without a DNS round trip.
  if (isIP(literalHost) !== 0) {
    if (isBlockedIpAddress(literalHost)) {
      throw new Error('private/internal URLs not allowed');
    }
    return [];
  }

  // Resolve through getaddrinfo (the same path the outbound fetch uses), which
  // also normalizes octal/hex/decimal IPv4 literals, then reject any private
  // address.
  let records;
  try {
    records = await dnsLookup(literalHost, { all: true, verbatim: true });
  } catch {
    if (!allowUnresolved) {
      throw new Error(`unable to resolve host: ${literalHost}`);
    }
    return [];
  }
  if (!Array.isArray(records)) return [];
  for (const record of records) {
    if (isBlockedIpAddress(record?.address)) {
      throw new Error('private/internal URLs not allowed');
    }
  }
  return records
    .filter((record) => record?.address)
    .map((record) => ({ address: record.address, family: record.family }));
}

// Validation-only wrapper used at URL-parse time (and anywhere the resolved
// addresses are not needed). Throws on a private/internal host.
export async function assertResolvedHostAllowed(hostname) {
  await resolvePinnedAddresses(hostname);
}
