import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const lockPath = process.env.NEOOS_CARGO_LOCK ?? join(process.cwd(), 'Cargo.lock');

function packageVersion(lockfile, packageName) {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = lockfile.match(
    new RegExp(`\\[\\[package\\]\\]\\nname = "${escaped}"\\nversion = "([^"]+)"`, 'u')
  );
  assert.ok(match, `${packageName} must be present in ${lockPath}`);
  return match[1];
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
