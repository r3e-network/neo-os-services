import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const lockPath = process.env.NEOOS_CARGO_LOCK ?? join(process.cwd(), 'Cargo.lock');
const signerManifestPath =
  process.env.NEOOS_SIGNER_CARGO_TOML ?? join(process.cwd(), 'workers', 'neo-signer', 'Cargo.toml');

// One [[package]] entry per locked version: a second entry for the same name
// means an older, possibly vulnerable copy is still in the graph.
function packageVersion(lockfile, packageName) {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const entries = lockfile
    .split(/^\[\[package\]\]\s*$/mu)
    .filter((entry) => new RegExp(`^name = "${escaped}"$`, 'mu').test(entry));
  assert.equal(entries.length, 1, `${lockPath} must contain exactly one ${packageName} package`);
  const [entry] = entries;
  assert.match(
    entry,
    /^source = "registry\+https:\/\/github\.com\/rust-lang\/crates\.io-index"$/mu,
    `${packageName} must come from the crates.io registry`
  );
  assert.match(entry, /^checksum = "[a-f0-9]{64}"$/mu, `${packageName} must carry a checksum`);
  const version = /^version = "([^"]+)"$/mu.exec(entry)?.[1];
  assert.ok(version, `${packageName} must have a locked version in ${lockPath}`);
  return version;
}

function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

test('Cargo.lock pins rustls past the TLS handshake advisory', () => {
  const lockfile = readFileSync(lockPath, 'utf8');
  const version = packageVersion(lockfile, 'rustls');
  assert.ok(
    compareVersions(version, '0.23.45') >= 0,
    `rustls ${version} is vulnerable to RUSTSEC-2026-0285; require >= 0.23.45`
  );
});

test('Cargo.lock pins protobuf past the uncontrolled recursion advisory', () => {
  const lockfile = readFileSync(lockPath, 'utf8');
  const version = packageVersion(lockfile, 'protobuf');
  assert.ok(
    compareVersions(version, '3.7.2') >= 0,
    `protobuf ${version} is vulnerable to RUSTSEC-2024-0437; require >= 3.7.2`
  );
});

test('neo-signer requires the prometheus line that depends on protobuf 3', () => {
  assert.match(
    readFileSync(signerManifestPath, 'utf8'),
    /^prometheus = "0\.14"$/mu,
    'prometheus 0.13 depends on protobuf 2 (RUSTSEC-2024-0437)'
  );
});

test('Cargo.lock excludes RustCrypto rsa affected by RUSTSEC-2023-0071', () => {
  assert.doesNotMatch(
    readFileSync(lockPath, 'utf8'),
    /^name = "rsa"$/mu,
    'RSA private operations must use the reviewed provider; no patched RustCrypto rsa release is available'
  );
});
