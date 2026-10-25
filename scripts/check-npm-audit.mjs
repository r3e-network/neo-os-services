// Blocking npm audit gate of ci.yml lint-and-format.
//
// It replaces the blanket `npm audit --audit-level=moderate`, which can fail on dev-only advisories
// with no upstream fix and, because a job stops at its first red step, keep every later gate of the
// job from ever running (SVC-V02).
//
// Policy:
//   1. Production scope (`npm audit --omit=dev`): no advisory at or above BLOCKING_SEVERITY.
//   2. Every other advisory (the full tree, `--include=dev`, minus what production already holds)
//      at or above BLOCKING_SEVERITY needs an entry in config/npm-audit-exceptions.json.
//   3. An exception is { advisory, package, reason, owner, expiresOn }. `reason` says why the
//      advisory is dev-only, `owner` is who answers for it, and `expiresOn` (YYYY-MM-DD, UTC) is the
//      first day it no longer holds, at most MAX_EXCEPTION_HORIZON_DAYS ahead. An expired
//      exception, a missing owner or expiry, an exception for an advisory that is in production
//      scope, and an exception that matches nothing in the current audit (stale) all fail the gate.
//   4. An audit that did not produce a report fails the gate. `npm audit --json` exits 1 with an
//      error-shaped JSON when the registry is unreachable, the same exit code as "vulnerabilities
//      found", so the report itself is validated and the exit code is never read as a verdict.
//      Such an outage is retried up to three times; a valid report, findings included, is final.
//
// Excepted advisories are printed by name on every run; the pass line is printed last.
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const BLOCKING_SEVERITY = 'moderate';
export const MAX_EXCEPTION_HORIZON_DAYS = 90;
export const EXCEPTIONS_FILE = 'config/npm-audit-exceptions.json';

const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];
const BLOCKING_RANK = SEVERITIES.indexOf(BLOCKING_SEVERITY);
const DOCUMENT_FIELDS = ['version', 'exceptions'];
const TEXT_FIELDS = ['advisory', 'package', 'reason', 'owner'];
const ENTRY_FIELDS = [...TEXT_FIELDS, 'expiresOn'];
const GHSA_PATTERN = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i;
const DAY_MS = 86_400_000;
const LOG_PREFIX = '[check:npm-audit]';
const AUDIT_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [500, 1500];

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';

export function utcToday(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function normalizeAdvisoryId(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const match = text.match(GHSA_PATTERN);
  return match && match[0].length === text.length ? `GHSA-${text.slice(5).toLowerCase()}` : null;
}

function advisoryIdFromUrl(url) {
  const match = typeof url === 'string' ? url.match(GHSA_PATTERN) : null;
  return match ? normalizeAdvisoryId(match[0]) : null;
}

function isRealDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

function describeFailure(report) {
  if (isText(report.message)) return report.message;
  const detail = isPlainObject(report.error) ? report.error.summary || report.error.detail : null;
  return isText(detail) ? detail : 'no detail reported';
}

// A report is usable only if npm says it is a v2 audit report whose own total agrees with it.
function reportProblems(report, label) {
  if (!isPlainObject(report)) return [`npm audit (${label}) did not return a JSON object`];
  if ('error' in report) return [`npm audit (${label}) failed: ${describeFailure(report)}`];
  if (report.auditReportVersion !== 2) {
    return [
      `npm audit (${label}) returned unsupported auditReportVersion ${report.auditReportVersion}`,
    ];
  }
  if (!isPlainObject(report.vulnerabilities)) {
    return [`npm audit (${label}) report has no vulnerabilities object`];
  }
  const total = report.metadata?.vulnerabilities?.total;
  const listed = Object.keys(report.vulnerabilities).length;
  if (!Number.isInteger(total)) {
    return [`npm audit (${label}) report has no numeric metadata.vulnerabilities.total`];
  }
  if (total !== listed) {
    return [
      `npm audit (${label}) report metadata.vulnerabilities.total is ${total} but the report lists ${listed}`,
    ];
  }
  return [];
}

// Every advisory the report names, keyed by (GHSA id, package). Packages that only inherit an
// advisory through a `via` chain carry no advisory of their own; each of them must still reach
// one, or the report is not understood and the gate fails closed.
function collectAdvisories(report, label, problems) {
  const advisories = new Map();
  const ownAdvisory = new Map();
  const chain = new Map();
  for (const [name, vulnerability] of Object.entries(report.vulnerabilities)) {
    const via = Array.isArray(vulnerability?.via) ? vulnerability.via : [];
    ownAdvisory.set(name, via.some(isPlainObject));
    chain.set(
      name,
      via.filter((entry) => typeof entry === 'string')
    );
    for (const entry of via.filter(isPlainObject)) {
      const pkg = isText(entry.name) ? entry.name : name;
      const id = advisoryIdFromUrl(entry.url);
      if (!id) {
        problems.push(
          `npm audit (${label}): advisory in ${pkg} has no GHSA identity (${String(entry.url)})`
        );
        continue;
      }
      if (!SEVERITIES.includes(entry.severity)) {
        problems.push(
          `npm audit (${label}): advisory ${id} in ${pkg} has unknown severity ${JSON.stringify(entry.severity)}`
        );
        continue;
      }
      advisories.set(`${id}|${pkg}`, {
        key: `${id}|${pkg}`,
        id,
        package: pkg,
        severity: entry.severity,
        title: isText(entry.title) ? entry.title : 'no title',
      });
    }
  }
  for (const name of ownAdvisory.keys()) {
    const seen = new Set();
    const pending = [name];
    let reaches = false;
    while (pending.length > 0 && !reaches) {
      const current = pending.pop();
      if (seen.has(current)) continue;
      seen.add(current);
      if (ownAdvisory.get(current)) reaches = true;
      pending.push(...(chain.get(current) ?? []));
    }
    if (!reaches)
      problems.push(`npm audit (${label}): vulnerable package ${name} traces to no advisory`);
  }
  return advisories;
}

function exceptionLabel(entry, index) {
  if (!isText(entry.advisory)) return `exceptions[${index}]`;
  return `exception ${entry.advisory.trim()}${isText(entry.package) ? ` (${entry.package.trim()})` : ''}`;
}

// Validates the exceptions document. Returns the entries that name an advisory and a package (they
// are matched against the audit whatever else is wrong with them, so one defect is one message).
function checkExceptions(document, today, problems) {
  if (!isPlainObject(document)) {
    problems.push('exceptions file must be a JSON object');
    return [];
  }
  for (const key of Object.keys(document)) {
    if (!DOCUMENT_FIELDS.includes(key)) problems.push(`exceptions file has unknown field "${key}"`);
  }
  if (document.version !== 1) problems.push('exceptions file "version" must be 1');
  if (!Array.isArray(document.exceptions)) {
    problems.push('exceptions file "exceptions" must be an array');
    return [];
  }
  const keyed = [];
  document.exceptions.forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      problems.push(`exceptions[${index}] must be an object`);
      return;
    }
    const label = exceptionLabel(entry, index);
    for (const key of Object.keys(entry)) {
      if (!ENTRY_FIELDS.includes(key)) problems.push(`${label}: unknown field "${key}"`);
    }
    for (const field of TEXT_FIELDS) {
      if (!isText(entry[field])) problems.push(`${label}: "${field}" must be a non-empty string`);
    }
    const id = normalizeAdvisoryId(entry.advisory);
    if (isText(entry.advisory) && !id) {
      problems.push(
        `${label}: "advisory" must be a GHSA id (got ${JSON.stringify(entry.advisory)})`
      );
    }
    if (!isRealDate(entry.expiresOn)) {
      problems.push(
        `${label}: "expiresOn" must be a real YYYY-MM-DD date (got ${String(JSON.stringify(entry.expiresOn))})`
      );
    } else if (today >= entry.expiresOn) {
      const owner = isText(entry.owner) ? entry.owner.trim() : 'unassigned';
      problems.push(
        `${label} expired on ${entry.expiresOn} (owner: ${owner}); fix the dependency or renew it with a reviewed date`
      );
    } else if (daysBetween(today, entry.expiresOn) > MAX_EXCEPTION_HORIZON_DAYS) {
      problems.push(
        `${label} expires on ${entry.expiresOn}, more than ${MAX_EXCEPTION_HORIZON_DAYS} days after ${today}`
      );
    }
    if (id && isText(entry.package)) {
      keyed.push({ entry, label, key: `${id}|${entry.package.trim()}`, id });
    }
  });
  return keyed;
}

export function evaluateNpmAudit({ production, full, exceptions, today = utcToday() }) {
  const problems = [];
  const notes = [];
  const excepted = [];

  const productionProblems = reportProblems(production, 'production');
  const fullProblems = reportProblems(full, 'full');
  problems.push(...productionProblems, ...fullProblems);
  const reportsUsable = productionProblems.length === 0 && fullProblems.length === 0;
  const productionAdvisories =
    productionProblems.length === 0
      ? collectAdvisories(production, 'production', problems)
      : new Map();
  const fullAdvisories =
    fullProblems.length === 0 ? collectAdvisories(full, 'full', problems) : new Map();

  const keyed = checkExceptions(exceptions, today, problems);
  const byKey = new Map(keyed.map((item) => [item.key, item]));

  for (const advisory of productionAdvisories.values()) {
    if (SEVERITIES.indexOf(advisory.severity) >= BLOCKING_RANK) {
      problems.push(
        `production dependency advisory ${advisory.id} (${advisory.severity}) in ${advisory.package} blocks the audit: ${advisory.title}`
      );
    } else {
      notes.push(
        `production advisory below ${BLOCKING_SEVERITY}: ${advisory.id} (${advisory.severity}) in ${advisory.package}: ${advisory.title}`
      );
    }
  }

  for (const advisory of fullAdvisories.values()) {
    if (productionAdvisories.has(advisory.key)) continue;
    const covered = byKey.get(advisory.key);
    if (covered) {
      const { entry } = covered;
      excepted.push({
        advisory: advisory.id,
        package: advisory.package,
        severity: advisory.severity,
        owner: isText(entry.owner) ? entry.owner.trim() : 'unassigned',
        expiresOn: entry.expiresOn,
        daysLeft: isRealDate(entry.expiresOn) ? daysBetween(today, entry.expiresOn) : null,
        reason: isText(entry.reason) ? entry.reason.trim() : '',
      });
    } else if (SEVERITIES.indexOf(advisory.severity) >= BLOCKING_RANK) {
      problems.push(
        `dev-only advisory ${advisory.id} (${advisory.severity}) in ${advisory.package} has no exception in ${EXCEPTIONS_FILE}: ${advisory.title}`
      );
    } else {
      notes.push(
        `dev-only advisory below ${BLOCKING_SEVERITY}: ${advisory.id} (${advisory.severity}) in ${advisory.package}: ${advisory.title}`
      );
    }
  }

  for (const { label, key } of keyed) {
    if (productionAdvisories.has(key)) {
      problems.push(`${label} covers an advisory that is in production scope; it is not dev-only`);
    } else if (reportsUsable && !fullAdvisories.has(key)) {
      problems.push(`${label} matches no advisory in the current audit; remove it`);
    }
  }

  return { problems, notes, excepted };
}

function pause(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function attemptNpmAudit(root, args, label) {
  const result = spawnSync('npm', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
  if (result.error) {
    return { problem: `npm audit (${label}) could not run: ${result.error.message}`, final: true };
  }
  if (result.status !== 0 && result.status !== 1) {
    return {
      problem: `npm audit (${label}) exited with ${result.status ?? result.signal}`,
      final: true,
    };
  }
  try {
    return { report: JSON.parse(result.stdout) };
  } catch {
    const detail = `${result.stdout || result.stderr || ''}`.trim().split('\n')[0];
    return {
      problem: `npm audit (${label}) did not print JSON (exit ${result.status}): ${detail}`,
    };
  }
}

// Runs one audit. When the registry cannot be reached npm falls back to a retired endpoint and
// exits 1 with an error-shaped JSON, so such an outcome is retried a bounded number of times. A
// valid report is final whatever it contains: findings are never retried away.
function runNpmAudit(root, args, label) {
  let outcome;
  for (let attempt = 1; attempt <= AUDIT_ATTEMPTS; attempt += 1) {
    outcome = attemptNpmAudit(root, args, label);
    const failure = outcome.problem ?? reportProblems(outcome.report, label)[0];
    if (!failure || outcome.final || attempt === AUDIT_ATTEMPTS) break;
    console.error(`${LOG_PREFIX} ${failure} (attempt ${attempt}/${AUDIT_ATTEMPTS}); retrying`);
    pause(RETRY_DELAYS_MS[attempt - 1]);
  }
  return outcome;
}

function readExceptions(root) {
  let text;
  try {
    text = readFileSync(`${root}/${EXCEPTIONS_FILE}`, 'utf8');
  } catch (error) {
    return { problem: `${EXCEPTIONS_FILE} could not be read: ${error.message}` };
  }
  try {
    return { document: JSON.parse(text) };
  } catch (error) {
    return { problem: `${EXCEPTIONS_FILE} is not valid JSON: ${error.message}` };
  }
}

function describeDaysLeft(daysLeft) {
  if (daysLeft === null) return 'no valid expiry';
  return daysLeft > 0 ? `${daysLeft} days left` : 'expired';
}

function main() {
  const root = process.cwd();
  const production = runNpmAudit(root, ['audit', '--omit=dev', '--json'], 'production');
  const full = runNpmAudit(root, ['audit', '--include=dev', '--json'], 'full');
  const exceptions = readExceptions(root);
  const inputProblems = [production.problem, full.problem, exceptions.problem].filter(Boolean);
  const result =
    inputProblems.length > 0
      ? { problems: inputProblems, notes: [], excepted: [] }
      : evaluateNpmAudit({
          production: production.report,
          full: full.report,
          exceptions: exceptions.document,
          today: utcToday(),
        });

  for (const item of result.excepted) {
    console.log(
      `${LOG_PREFIX} exception ${item.advisory} (${item.package}, ${item.severity}) ` +
        `owner "${item.owner}" expires ${item.expiresOn} (${describeDaysLeft(item.daysLeft)}): ${item.reason}`
    );
  }
  for (const note of result.notes) console.log(`${LOG_PREFIX} note: ${note}`);
  if (result.problems.length > 0) {
    for (const problem of result.problems) console.error(`${LOG_PREFIX} ${problem}`);
    console.error(`${LOG_PREFIX} failed with ${result.problems.length} problem(s)`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `${LOG_PREFIX} passed: production scope: 0 advisories at or above ${BLOCKING_SEVERITY}; ` +
      `${result.excepted.length} dev-only advisory(ies) covered by reviewed exceptions in ${EXCEPTIONS_FILE}`
  );
}

function isMain() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (process.argv[1] && isMain()) main();
