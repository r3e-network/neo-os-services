#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const ALLOWED_VULNERABILITIES = new Map([
  ['@cityofzion/neon-api', 'low'],
  ['@cityofzion/neon-core', 'high'],
  ['@cityofzion/neon-js', 'low'],
  ['elliptic', 'low'],
  ['lodash', 'high'],
]);

function fail(message, detail = '') {
  console.error(`[root audit] ${message}`);
  if (detail) console.error(detail);
  process.exit(1);
}

const audit = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});

if (![0, 1].includes(audit.status ?? 1)) {
  fail('npm audit did not complete successfully.', audit.stderr || audit.stdout || '');
}

const rawReport = `${audit.stdout || ''}`.trim();
if (!rawReport) {
  fail('npm audit returned no JSON output.', audit.stderr || '');
}

let report;
try {
  report = JSON.parse(rawReport);
} catch (error) {
  fail(
    'npm audit JSON could not be parsed.',
    error instanceof Error ? error.message : String(error)
  );
}

const vulnerabilities = report?.vulnerabilities || {};
const counts = report?.metadata?.vulnerabilities || {};
const observedNames = Object.keys(vulnerabilities).sort();

for (const [name, meta] of Object.entries(vulnerabilities)) {
  const severity = String(meta?.severity || '').toLowerCase();
  const allowedSeverity = ALLOWED_VULNERABILITIES.get(name);
  if (!allowedSeverity) {
    fail(
      'Found a vulnerability outside the accepted CityOfZion baseline.',
      `${name}:${severity || 'unknown'}`
    );
  }
  if (severity !== allowedSeverity) {
    fail(
      'Observed an allowed vulnerability with an unexpected severity.',
      `${name}: expected ${allowedSeverity}, received ${severity || 'unknown'}`
    );
  }
}

if ((counts.critical || 0) > 0) {
  fail('Critical vulnerabilities are never allowed.', `critical=${counts.critical}`);
}

if ((counts.moderate || 0) > 0) {
  fail(
    'Moderate vulnerabilities are outside the accepted excluded baseline.',
    `moderate=${counts.moderate}`
  );
}

const unexpectedCount = observedNames.length - ALLOWED_VULNERABILITIES.size;
if (unexpectedCount > 0) {
  fail('Observed more vulnerabilities than the accepted baseline.', observedNames.join(', '));
}

console.log(
  `[root audit] Accepted excluded CityOfZion baseline preserved (${counts.high || 0} high / ${counts.low || 0} low / ${counts.total || 0} total).`
);
console.log(`[root audit] Observed packages: ${observedNames.join(', ')}`);
