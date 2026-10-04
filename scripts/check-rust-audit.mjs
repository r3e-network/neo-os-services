import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const EXPECTED_UNMAINTAINED = new Set(['RUSTSEC-2024-0436', 'RUSTSEC-2021-0127']);
const MAX_DATABASE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const root = process.cwd();

function fail(message) {
  console.error(`[check:rust:audit] ${message}`);
  process.exitCode = 1;
}

const result = spawnSync('cargo', ['audit', '--json', '--deny', 'unsound', '--deny', 'yanked'], {
  cwd: root,
  encoding: 'utf8',
});

if (result.error) {
  fail(`could not run cargo audit: ${result.error.message}`);
} else if (result.status !== 0) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  fail(`cargo audit exited with ${result.status}`);
} else {
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (error) {
    fail(`cargo audit returned invalid JSON: ${error.message}`);
  }

  if (!report || typeof report !== 'object') {
    fail('cargo audit returned a non-object report');
  }

  const vulnerabilities = report?.vulnerabilities?.list;
  const unmaintained = report?.warnings?.unmaintained;
  const databaseUpdated = report?.database?.['last-updated'];
  if (!Array.isArray(vulnerabilities)) {
    fail('cargo audit report has no vulnerabilities.list array');
  }
  if (!Array.isArray(unmaintained)) {
    fail('cargo audit report has no warnings.unmaintained array');
  }
  const databaseUpdatedAt = Date.parse(databaseUpdated || '');
  if (!Number.isFinite(databaseUpdatedAt)) {
    fail('cargo audit report has no valid database.last-updated timestamp');
  } else if (
    databaseUpdatedAt > Date.now() + 5 * 60 * 1000 ||
    Date.now() - databaseUpdatedAt > MAX_DATABASE_AGE_MS
  ) {
    fail(`cargo audit advisory database is stale or from the future: ${databaseUpdated}`);
  }

  if (Array.isArray(vulnerabilities) && vulnerabilities.length > 0) {
    fail(
      `unreviewed vulnerabilities remain: ${vulnerabilities
        .map((entry) => entry.advisory?.id || 'unknown')
        .join(', ')}`
    );
  }

  if (Array.isArray(unmaintained)) {
    const unmaintainedIds = unmaintained.map((entry, index) => {
      const id = entry?.advisory?.id;
      if (typeof id !== 'string' || id.trim() === '') {
        fail(`cargo audit returned an unmaintained warning without advisory id at index ${index}`);
        return null;
      }
      return id;
    });
    const unexpectedUnmaintained = unmaintainedIds.filter(
      (id) => id && !EXPECTED_UNMAINTAINED.has(id)
    );
    if (unexpectedUnmaintained.length > 0) {
      fail(`unreviewed unmaintained warnings remain: ${unexpectedUnmaintained.join(', ')}`);
    }

    const deniedWarningKinds = ['unsound', 'yanked'].flatMap((kind) => {
      const warnings = report?.warnings?.[kind];
      if (warnings === undefined) return [];
      if (!Array.isArray(warnings)) {
        fail(`cargo audit returned malformed warnings.${kind}`);
        return [];
      }
      return warnings;
    });
    if (deniedWarningKinds.length > 0) {
      fail('cargo audit reported denied unsound or yanked warnings');
    }
  }

  if (process.exitCode !== 1) {
    console.log(
      `[check:rust:audit] passed: 0 unreviewed vulnerabilities; ` +
        `${unmaintained.length} reviewed unmaintained warnings; ` +
        `advisory database ${databaseUpdated}; no vulnerability exceptions`
    );
  }
}

const lock = readFileSync(join(root, 'Cargo.lock'), 'utf8');
const rsaEntries = lock.match(/\[\[package\]\][\s\S]*?(?=\n\[\[package\]\]|\s*$)/g) || [];
const rsaPackages = rsaEntries.filter((entry) => /^name = "rsa"$/m.test(entry));
if (rsaPackages.length !== 0) {
  fail('Cargo.lock must not contain RustCrypto rsa; production RSA uses aws-lc-rs');
}
