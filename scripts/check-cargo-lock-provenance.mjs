import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = 'scripts/fixtures/cargo-lock-provenance.json';

export function parseLockPackageVersions(lockSource) {
  const versions = new Map();
  let name = null;
  for (const line of lockSource.split(/\r?\n/)) {
    if (line.startsWith('name = ')) {
      name = line.slice('name = '.length).trim().replaceAll('"', '');
    } else if (name && line.startsWith('version = ')) {
      const version = line.slice('version = '.length).trim().replaceAll('"', '');
      const existing = versions.get(name) || [];
      existing.push(version);
      versions.set(name, existing);
      name = null;
    }
  }
  return versions;
}

export function loadProvenanceFixture(root = repoRoot) {
  return JSON.parse(readFileSync(join(root, FIXTURE), 'utf8'));
}

export function auditCargoLockProvenance(root = repoRoot) {
  const problems = [];
  const fixture = loadProvenanceFixture(root);
  const versions = parseLockPackageVersions(readFileSync(join(root, 'Cargo.lock'), 'utf8'));

  for (const name of fixture.retiredLockPackages) {
    if (versions.has(name)) {
      problems.push(
        `Cargo.lock still contains retired-graph package ${name} (${versions.get(name).join(', ')})`
      );
    }
  }

  for (const leftover of fixture.leftoverUpgrades) {
    const actual = versions.get(leftover.name) || [];
    const expected = leftover.versions || [leftover.version];
    const actualSorted = [...actual].sort();
    const expectedSorted = [...expected].sort();
    if (actualSorted.length === 0) {
      problems.push(
        `documented leftover ${leftover.name} is gone from Cargo.lock; remove it from ${FIXTURE}`
      );
      continue;
    }
    if (actualSorted.join(',') !== expectedSorted.join(',')) {
      problems.push(
        `leftover ${leftover.name} versions ${actualSorted.join(', ')} do not match documented ${expectedSorted.join(', ')} (${leftover.status}: ${leftover.note})`
      );
    }
  }

  return problems;
}

function main() {
  const problems = auditCargoLockProvenance();
  if (problems.length > 0) {
    console.error('Cargo.lock provenance audit failed:');
    for (const problem of problems) console.error(`- ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log('Cargo.lock provenance audit passed.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
