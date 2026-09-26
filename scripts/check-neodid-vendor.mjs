#!/usr/bin/env node
/**
 * NeoDID pin gate.
 *
 * neo-os-did owns the NeoDID files this repository runs and the NeoDID data it
 * reads. vendor/neo-os-did.pin.json names one neo-os-did commit and records,
 * for every pinned file, its path in neo-os-did (`source`), its path in this
 * repository (`dest`) and its SHA-256. A pinned file is a byte-identical copy:
 * a change it needs is made in neo-os-did and arrives by moving the pin.
 *
 * The gate fails when:
 *   1. the pin is not schema 2: a repository, a full commit id, and a
 *      non-empty list of {source, dest, sha256} entries whose paths are
 *      normalized and repository-relative and whose destinations are unique;
 *   2. a dest is missing, is not a regular file, or does not hash to its
 *      sha256;
 *   3. a file under vendor/neo-os-did/ is not a declared dest (an orphan);
 *   4. a sibling neo-os-did checkout is found (NEOOS_DID_CHECKOUT, else
 *      ../neo-os-did or ../../neo-os-did) and its HEAD is not the pin commit,
 *      or a source at the pin commit does not hash to its sha256.
 *      NEOOS_DID_CHECKOUT naming anything but a git checkout is a failure, not
 *      a skipped check.
 *
 * Exported as a function so scripts/check-neodid-vendor.test.mjs can drive each
 * rule against a throwaway tree; run as a CLI it audits this repository.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PIN_FILE = 'vendor/neo-os-did.pin.json';
export const VENDOR_DIR = 'vendor/neo-os-did';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ENTRY_KEYS = new Set(['source', 'dest', 'sha256']);
const FULL_COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A normalized, forward-slash path inside the repository: no `.`/`..`/empty segment. */
export function isRepoRelativePath(path) {
  return (
    typeof path === 'string' &&
    path !== '' &&
    !path.includes('\\') &&
    !path.startsWith('/') &&
    posix.normalize(path) === path &&
    path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  );
}

function auditPinShape(pin) {
  if (!isPlainObject(pin)) return [`${PIN_FILE}: expected a JSON object`];
  const problems = [];
  if (pin.schemaVersion !== 2) {
    problems.push(`${PIN_FILE}: schemaVersion must be 2, got ${JSON.stringify(pin.schemaVersion)}`);
  }
  if (typeof pin.repository !== 'string' || pin.repository.trim() === '') {
    problems.push(`${PIN_FILE}: repository is required`);
  }
  if (typeof pin.commit !== 'string' || !FULL_COMMIT.test(pin.commit)) {
    problems.push(`${PIN_FILE}: commit must be a full 40-character lowercase commit id`);
  }
  if (!Array.isArray(pin.files) || pin.files.length === 0) {
    problems.push(`${PIN_FILE}: files must be a non-empty list`);
    return problems;
  }
  const dests = new Set();
  pin.files.forEach((entry, index) => {
    const label = `${PIN_FILE}: files[${index}]`;
    if (!isPlainObject(entry)) {
      problems.push(`${label}: expected an object`);
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!ENTRY_KEYS.has(key)) problems.push(`${label}: unknown property ${key}`);
    }
    if (!isRepoRelativePath(entry.source)) {
      problems.push(`${label}: source must be a normalized repository-relative path`);
    }
    if (!isRepoRelativePath(entry.dest)) {
      problems.push(`${label}: dest must be a normalized repository-relative path`);
    } else if (entry.dest === PIN_FILE) {
      problems.push(`${label}: dest must not be the pin file itself`);
    } else if (dests.has(entry.dest)) {
      problems.push(`${label}: dest ${entry.dest} is declared more than once`);
    } else {
      dests.add(entry.dest);
    }
    if (typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256)) {
      problems.push(`${label}: sha256 must be 64 lowercase hex characters`);
    }
  });
  return problems;
}

function auditDestinations(root, files) {
  const problems = [];
  for (const entry of files) {
    const file = join(root, entry.dest);
    if (!existsSync(file)) {
      problems.push(`missing pinned NeoDID file: ${entry.dest}`);
      continue;
    }
    if (!lstatSync(file).isFile()) {
      problems.push(`pinned NeoDID file is not a regular file: ${entry.dest}`);
      continue;
    }
    const actual = digest(readFileSync(file));
    if (actual !== entry.sha256) {
      problems.push(`NeoDID pin drift: ${entry.dest} expected ${entry.sha256} got ${actual}`);
    }
  }
  return problems;
}

function listFiles(dir, prefix) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...listFiles(join(dir, entry.name), relative));
    else found.push(relative);
  }
  return found;
}

function auditOrphans(root, files) {
  const vendorDir = join(root, VENDOR_DIR);
  if (!existsSync(vendorDir)) return [];
  const declared = new Set(files.map((entry) => entry.dest));
  return listFiles(vendorDir, VENDOR_DIR)
    .sort()
    .filter((file) => !declared.has(file))
    .map((file) => `orphan under ${VENDOR_DIR}/: ${file} is not declared in ${PIN_FILE}`);
}

/** The neo-os-did checkout to compare against, or null when none is present. */
export function findSiblingCheckout(root, env = process.env) {
  const explicit = typeof env.NEOOS_DID_CHECKOUT === 'string' ? env.NEOOS_DID_CHECKOUT.trim() : '';
  if (explicit) return { path: resolve(explicit), explicit: true };
  for (const candidate of [
    resolve(root, '..', 'neo-os-did'),
    resolve(root, '..', '..', 'neo-os-did'),
  ]) {
    if (existsSync(join(candidate, '.git'))) return { path: candidate, explicit: false };
  }
  return null;
}

function git(cwd, args, options = {}) {
  return execFileSync('git', ['-C', cwd, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function auditSibling(sibling, pin) {
  if (!existsSync(join(sibling.path, '.git'))) {
    return [`NEOOS_DID_CHECKOUT=${sibling.path} is not a git checkout of neo-os-did`];
  }
  let head;
  try {
    head = git(sibling.path, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch (error) {
    return [`could not read the NeoDID sibling checkout ${sibling.path}: ${error.message}`];
  }
  if (head !== pin.commit) {
    return [`NeoDID sibling drift: ${sibling.path} is at ${head}, the pin names ${pin.commit}`];
  }
  const problems = [];
  for (const entry of pin.files) {
    let bytes;
    try {
      bytes = git(sibling.path, ['cat-file', 'blob', `${pin.commit}:${entry.source}`]);
    } catch {
      problems.push(`missing NeoDID source at ${pin.commit}: ${entry.source}`);
      continue;
    }
    const actual = digest(bytes);
    if (actual !== entry.sha256) {
      problems.push(
        `NeoDID source/pin mismatch: ${entry.source} at ${pin.commit} is ${actual}, the pin records ${entry.sha256}`
      );
    }
  }
  return problems;
}

/**
 * Audits the pin of the repository at `root`. Returns the problems found (empty
 * when the tree matches the pin) and a summary of what was checked.
 */
export function checkNeoDidVendor({ root = REPO_ROOT, env = process.env } = {}) {
  const summary = {
    repository: null,
    commit: null,
    files: 0,
    siblingChecked: false,
    sibling: null,
  };
  const pinPath = join(root, PIN_FILE);
  if (!existsSync(pinPath)) return { problems: [`${PIN_FILE} is missing`], summary };
  let pin;
  try {
    pin = JSON.parse(readFileSync(pinPath, 'utf8'));
  } catch (error) {
    return { problems: [`${PIN_FILE} is not valid JSON: ${error.message}`], summary };
  }
  const shapeProblems = auditPinShape(pin);
  if (shapeProblems.length > 0) return { problems: shapeProblems, summary };
  summary.repository = pin.repository;
  summary.commit = pin.commit;
  summary.files = pin.files.length;

  const problems = [...auditDestinations(root, pin.files), ...auditOrphans(root, pin.files)];
  const sibling = findSiblingCheckout(root, env);
  if (sibling) {
    problems.push(...auditSibling(sibling, pin));
    summary.siblingChecked = true;
    summary.sibling = sibling.path;
  }
  return { problems, summary };
}

function main() {
  const { problems, summary } = checkNeoDidVendor();
  if (problems.length > 0) {
    console.error('NeoDID pin gate failed:');
    for (const problem of problems) console.error(`- ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(summary));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
