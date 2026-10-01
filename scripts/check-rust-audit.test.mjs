import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = process.cwd();
const checker = join(root, 'scripts', 'check-rust-audit.mjs');
const lock = `[[package]]
name = "rsa"
version = "0.9.10"
source = "registry+https://github.com/rust-lang/crates.io-index"
`;

function runWithReport(report) {
  const directory = mkdtempSync(join(tmpdir(), 'neoos-rust-audit-'));
  const bin = join(directory, 'bin');
  const cargo = join(bin, 'cargo');
  try {
    mkdirSync(bin);
    writeFileSync(join(directory, 'Cargo.lock'), lock);
    writeFileSync(cargo, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(report)}'\n`);
    chmodSync(cargo, 0o700);
    return spawnSync(process.execPath, [checker], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH || ''}` },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('audit gate rejects a zero-exit malformed report instead of treating it as clean', () => {
  const result = runWithReport({});
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /vulnerabilities\.list array/);
});

test('audit gate rejects denied warning classes even when cargo exits zero', () => {
  const result = runWithReport({
    database: { 'last-updated': new Date().toISOString() },
    vulnerabilities: { list: [] },
    warnings: {
      unmaintained: [],
      unsound: [{ advisory: { id: 'RUSTSEC-test' } }],
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /denied unsound or yanked/);
});

test('audit gate rejects warning entries without advisory identities', () => {
  const result = runWithReport({
    database: { 'last-updated': new Date().toISOString() },
    vulnerabilities: { list: [] },
    warnings: { unmaintained: [{}] },
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /without advisory id/);
});

test('audit gate rejects non-array denied warning fields', () => {
  const result = runWithReport({
    database: { 'last-updated': new Date().toISOString() },
    vulnerabilities: { list: [] },
    warnings: { unmaintained: [], yanked: {} },
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /malformed warnings\.yanked/);
});
