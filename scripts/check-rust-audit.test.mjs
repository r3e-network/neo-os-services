import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { validateReviewedUnmaintained } from './check-rust-audit.mjs';

const root = process.cwd();
const checker = join(root, 'scripts', 'check-rust-audit.mjs');
const lock = `[[package]]
name = "aws-lc-rs"
version = "1.18.1"
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

test('audit gate rejects cargo audit advisory ignores', () => {
  const result = runWithReport({
    database: { 'last-updated': new Date().toISOString() },
    vulnerabilities: { list: [], found: false },
    warnings: { unmaintained: [], unsound: [], yanked: [] },
    settings: { ignore: ['RUSTSEC-2026-0285'] },
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /advisory ignore/);
});

test('audit gate accepts exactly the reviewed unmaintained warnings', () => {
  const result = runWithReport({
    database: { 'last-updated': new Date().toISOString() },
    vulnerabilities: { list: [] },
    warnings: {
      unmaintained: [
        { advisory: { id: 'RUSTSEC-2024-0436' } },
        { advisory: { id: 'RUSTSEC-2021-0127' } },
      ],
    },
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /2 reviewed unmaintained warnings/);
});

test('audit gate rejects a project cargo audit configuration', () => {
  const directory = mkdtempSync(join(tmpdir(), 'neoos-rust-audit-config-'));
  const bin = join(directory, 'bin');
  try {
    mkdirSync(bin);
    writeFileSync(join(directory, 'Cargo.lock'), lock);
    mkdirSync(join(directory, '.cargo'));
    writeFileSync(join(directory, '.cargo', 'audit.toml'), '[advisories]\nignore = []\n');
    const cargo = join(bin, 'cargo');
    writeFileSync(
      cargo,
      `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({
        database: { 'last-updated': new Date().toISOString() },
        vulnerabilities: { list: [] },
        warnings: { unmaintained: [], unsound: [], yanked: [] },
      })}'`
    );
    chmodSync(cargo, 0o700);
    const result = spawnSync(process.execPath, [checker], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH || ''}` },
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /audit\.toml/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('audit policy requires owner, reason, and expiry metadata for each allowlist id', () => {
  const result = validateReviewedUnmaintained(
    [{ advisory: { id: 'RUSTSEC-2024-0436' } }],
    Date.parse('2026-10-05T00:00:00Z'),
    { 'RUSTSEC-2024-0436': { owner: '', reason: '', expiresOn: 'not-a-date' } }
  );
  assert.match(result.problems.join('\n'), /owner/);
  assert.match(result.problems.join('\n'), /reason/);
  assert.match(result.problems.join('\n'), /expiresOn/);
});

test('audit policy rejects an allowlisted warning after its expiry', () => {
  const result = validateReviewedUnmaintained(
    [{ advisory: { id: 'RUSTSEC-2024-0436' } }],
    Date.parse('2026-10-05T00:00:00Z'),
    { 'RUSTSEC-2024-0436': { owner: 'owner', reason: 'migration debt', expiresOn: '2020-01-01' } }
  );
  assert.match(result.problems.join('\n'), /expired/);
});

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
