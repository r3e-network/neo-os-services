import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_DATABASE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const LOG_PREFIX = '[check:rust:audit]';

export const REVIEWED_UNMAINTAINED = Object.freeze({
  'RUSTSEC-2024-0436': Object.freeze({
    owner: 'NeoOS program lead (delegated by the owner)',
    reason:
      'paste is unmaintained through the vendored boa_engine dependency; migration is tracked',
    expiresOn: '2026-11-05',
  }),
  'RUSTSEC-2021-0127': Object.freeze({
    owner: 'NeoOS program lead (delegated by the owner)',
    reason: 'serde_cbor is unmaintained through the Nitro NSM API dependency; migration is tracked',
    expiresOn: '2026-11-05',
  }),
});

function fail(message) {
  console.error(`${LOG_PREFIX} ${message}`);
  process.exitCode = 1;
}

function isRealDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export function validateReviewedUnmaintained(
  entries,
  now = Date.now(),
  policyMap = REVIEWED_UNMAINTAINED
) {
  const problems = [];
  const reported = new Set();
  if (!Array.isArray(entries))
    return { problems: ['cargo audit report has no warnings.unmaintained array'] };

  entries.forEach((entry, index) => {
    const id = entry?.advisory?.id;
    if (typeof id !== 'string' || id.trim() === '') {
      problems.push(
        `cargo audit returned an unmaintained warning without advisory id at index ${index}`
      );
      return;
    }
    const policy = policyMap[id];
    if (!policy) {
      problems.push(`unreviewed unmaintained warnings remain: ${id}`);
      return;
    }
    reported.add(id);
    for (const field of ['owner', 'reason']) {
      if (typeof policy[field] !== 'string' || policy[field].trim() === '') {
        problems.push(`reviewed unmaintained ${id} must have a non-empty ${field}`);
      }
    }
    if (!isRealDate(policy.expiresOn)) {
      problems.push(`reviewed unmaintained ${id} must have a real expiresOn date`);
    } else if (Date.parse(`${policy.expiresOn}T00:00:00Z`) <= now) {
      problems.push(`reviewed unmaintained ${id} exception expired on ${policy.expiresOn}`);
    }
  });

  for (const id of Object.keys(policyMap)) {
    if (!reported.has(id)) problems.push(`reviewed unmaintained ${id} is no longer reported`);
  }
  return { problems, count: entries.length };
}

export function validateAuditReport(report, now = Date.now()) {
  const problems = [];
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return { problems: ['cargo audit returned a non-object report'], unmaintainedCount: 0 };
  }

  const vulnerabilities = report?.vulnerabilities?.list;
  const unmaintained = report?.warnings?.unmaintained;
  const databaseUpdated = report?.database?.['last-updated'];
  if (!Array.isArray(vulnerabilities))
    problems.push('cargo audit report has no vulnerabilities.list array');
  if (!Array.isArray(unmaintained))
    problems.push('cargo audit report has no warnings.unmaintained array');

  const ignore = report?.settings?.ignore;
  if (ignore !== undefined && !Array.isArray(ignore)) {
    problems.push('cargo audit report settings.ignore is malformed');
  } else if (Array.isArray(ignore) && ignore.length > 0) {
    problems.push(`cargo audit report contains advisory ignore entries: ${ignore.join(', ')}`);
  }

  const databaseUpdatedAt = Date.parse(databaseUpdated || '');
  if (!Number.isFinite(databaseUpdatedAt)) {
    problems.push('cargo audit report has no valid database.last-updated timestamp');
  } else if (
    databaseUpdatedAt > now + 5 * 60 * 1000 ||
    now - databaseUpdatedAt > MAX_DATABASE_AGE_MS
  ) {
    problems.push(`cargo audit advisory database is stale or from the future: ${databaseUpdated}`);
  }

  if (Array.isArray(vulnerabilities) && vulnerabilities.length > 0) {
    problems.push(
      `unreviewed vulnerabilities remain: ${vulnerabilities.map((entry) => entry.advisory?.id || 'unknown').join(', ')}`
    );
  }

  const reviewed = validateReviewedUnmaintained(unmaintained, now);
  problems.push(...reviewed.problems);
  const deniedWarningKinds = ['unsound', 'yanked'].flatMap((kind) => {
    const warnings = report?.warnings?.[kind];
    if (warnings === undefined) return [];
    if (!Array.isArray(warnings)) {
      problems.push(`cargo audit returned malformed warnings.${kind}`);
      return [];
    }
    return warnings;
  });
  if (deniedWarningKinds.length > 0)
    problems.push('cargo audit reported denied unsound or yanked warnings');

  return { problems, unmaintainedCount: reviewed.count ?? 0, databaseUpdated };
}

export function main() {
  const root = process.cwd();
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
    const validation = validateAuditReport(report);
    validation.problems.forEach(fail);
    if (existsSync(join(root, '.cargo', 'audit.toml'))) {
      fail('project .cargo/audit.toml is forbidden because it can hide advisories');
    }
    if (process.exitCode !== 1) {
      const lock = readFileSync(join(root, 'Cargo.lock'), 'utf8');
      const rsaEntries = lock.match(/\[\[package\]\][\s\S]*?(?=\n\[\[package\]\]|\s*$)/g) || [];
      if (rsaEntries.some((entry) => /^name = "rsa"$/m.test(entry))) {
        fail('Cargo.lock must not contain RustCrypto rsa; production RSA uses aws-lc-rs');
      }
    }
    if (process.exitCode !== 1) {
      console.log(
        `${LOG_PREFIX} passed: 0 unreviewed vulnerabilities; ${validation.unmaintainedCount} reviewed unmaintained warnings; advisory database ${validation.databaseUpdated}; no vulnerability exceptions`
      );
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
