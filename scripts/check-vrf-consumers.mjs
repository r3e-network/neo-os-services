#!/usr/bin/env node
// Repository integration review, not runtime caller authentication or economic analysis.
// Candidate discovery is deliberately conservative; --base also requires review of
// EVERY changed executable/config input, including opaque/dynamic calls. Full-file
// hashes bind human classification to bytes. A caller's non-value flag has no role.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const POLICY = 'baselines/vrf-consumers.json';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CONTROL = new Set([
  POLICY,
  'scripts/check-vrf-consumers.mjs',
  'packages/shared/src/public-runtime.test.mjs',
  '.github/workflows/ci.yml',
]);
const SOURCE = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.rs',
  '.sol',
  '.cs',
  '.sh',
  '.py',
  '.json',
  '.yml',
  '.yaml',
  '.toml',
  '.go',
  '.c',
  '.cpp',
  '.h',
]);
const MARKER =
  /vrf|random[._]generate|["'](?:random|rng)["']|\/automation\/execute|\/oracle\/fulfill/i;
// DEC-CU-22 bootstrap ceiling. Only this existing economic consumer is debt;
// its wager driver is an input of that same consumer, never labelled non-value.
const DEBT = {
  consumer: 'contracts-evm/MiniAppDiceGameEVM.sol',
  owner: 'services lead',
  remediation: 'E-VRF1',
  expires: '2026-11-30',
  inputs: {
    'contracts-evm/MiniAppDiceGameEVM.sol':
      'd379663d51c18c4b87fb5b15b4fc8cf3b32db37a49731fec81b2593f3aef910c',
    'deploy/evm/validate-dice.mjs':
      '3ad6cc855a86c1d99ff35347b7d31c62fa2419c55f9d45f422147a4dc878a43d',
  },
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const text = (v) => typeof v === 'string' && v.trim().length > 0;
function requireRule(ok, message) {
  if (!ok) throw new Error(message);
}
function validate(policy) {
  requireRule(object(policy) && policy.version === 1, 'policy version must be 1');
  requireRule(Array.isArray(policy.reviews), 'policy reviews must be an array');
  const consumers = new Set();
  const inputs = new Map();
  for (const r of policy.reviews) {
    requireRule(object(r) && text(r.consumer), 'review needs consumer');
    requireRule(!consumers.has(r.consumer), `duplicate consumer ${r.consumer}`);
    consumers.add(r.consumer);
    requireRule(text(r.owner), `${r.consumer}: missing owner`);
    requireRule(text(r.justification), `${r.consumer}: missing justification`);
    requireRule(
      ['non-value', 'value-bearing-known-debt'].includes(r.classification),
      `${r.consumer}: invalid classification`
    );
    requireRule(
      object(r.inputs) && Object.keys(r.inputs).length > 0,
      `${r.consumer}: missing inputs`
    );
    for (const [path, binding] of Object.entries(r.inputs)) {
      const sha = binding?.sha256;
      requireRule(
        path.split('/').every((p) => p && p !== '.' && p !== '..') && !path.includes('\\'),
        `invalid input path ${path}`
      );
      requireRule(!CONTROL.has(path), `gate control path cannot be a consumer: ${path}`);
      requireRule(/^[a-f0-9]{64}$/.test(sha), `invalid hash for ${path}`);
      requireRule(!inputs.has(path), `duplicate input ${path}`);
      inputs.set(path, { sha, review: r });
    }
  }
  return inputs;
}
function debtCheck(r, before, today) {
  requireRule(
    r.consumer === DEBT.consumer && r.owner === DEBT.owner && r.remediation === DEBT.remediation,
    `${r.consumer}: unapproved debt (owner/remediation/identity)`
  );
  requireRule(
    /^\d{4}-\d{2}-\d{2}$/.test(r.expires) &&
      Number.isFinite(Date.parse(r.expires)) &&
      new Date(r.expires).toISOString().slice(0, 10) === r.expires,
    'debt expires must be a real calendar date'
  );
  requireRule(r.expires > today, `debt expired on ${r.expires}`);
  requireRule(
    Date.parse(r.expires) - Date.parse(today) <= 60 * 86400000,
    'debt exceeds 60 day horizon'
  );
  requireRule(r.expires <= DEBT.expires, 'debt expiry exceeds approved ceiling');
  requireRule(before, 'debt added since base');
  requireRule(r.expires <= before.expires, 'debt expiry extended since base');
  for (const [p, binding] of Object.entries(r.inputs)) {
    const sha = binding?.sha256;
    requireRule(
      DEBT.inputs[p] === sha &&
        (before === DEBT ? before.inputs[p] : before.inputs[p]?.sha256) === sha,
      `debt input added or changed: ${p}`
    );
  }
}
function main() {
  let root = ROOT,
    base = null;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    requireRule(
      ['--root', '--base'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('-'),
      'invalid argument'
    );
    if (args[i] === '--root') root = resolve(args[++i]);
    else base = args[++i];
  }
  const git = (...a) =>
    execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const policy = JSON.parse(readFileSync(resolve(root, POLICY), 'utf8'));
  // Print debt before validation so red runs cannot hide it.
  for (const r of policy?.reviews || []) {
    if (r?.classification === 'value-bearing-known-debt')
      console.log(
        `DEBT value-bearing-known-debt ${r.consumer}; expires ${r.expires}; remediation ${r.remediation}; owner ${r.owner}`
      );
  }
  const inputs = validate(policy);
  let before = null,
    changed = [];
  if (base !== null) {
    requireRule(/^[0-9A-Za-z][0-9A-Za-z._/~^@-]*$/.test(base), 'invalid base ref');
    let commit;
    try {
      commit = git('rev-parse', '--verify', `${base}^{commit}`).trim();
    } catch {
      throw new Error('base must resolve to a local commit');
    }
    if (git('ls-tree', '--name-only', commit, '--', POLICY).trim()) {
      before = JSON.parse(git('show', `${commit}:${POLICY}`));
      validate(before);
    }
    changed = git('diff', '--name-only', '-z', '--diff-filter=ACMRTUXB', commit, '--')
      .split('\0')
      .filter(Boolean);
  }
  const today = new Date().toISOString().slice(0, 10);
  for (const r of policy.reviews) {
    if (r.classification === 'value-bearing-known-debt') {
      debtCheck(
        r,
        before
          ? before.reviews.find(
              (b) => b.consumer === r.consumer && b.classification === r.classification
            )
          : DEBT,
        today
      );
    }
  }
  // A debt input cannot be laundered as non-value while its reviewed bytes remain.
  for (const path of Object.keys(DEBT.inputs)) {
    const input = inputs.get(path);
    if (input)
      requireRule(
        input.review.classification === 'value-bearing-known-debt',
        `debt cannot be reclassified: ${path}`
      );
  }
  const files = git('ls-files', '-z', '--cached', '--others', '--exclude-standard')
    .split('\0')
    .filter(Boolean);
  const changedSet = new Set(changed);
  const found = new Set();
  for (const path of new Set(files)) {
    if (CONTROL.has(path)) continue;
    const full = resolve(root, path);
    // Deletions are shrinkage. Other failures, including symlinks, are errors.
    let stat;
    try {
      stat = lstatSync(full);
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    const bytes = stat.isFile() ? readFileSync(full) : Buffer.alloc(0);
    // Executable modes and shebangs take precedence over documentation extensions.
    const isSource =
      (stat.mode & 0o111) !== 0 ||
      bytes.subarray(0, 2).toString() === '#!' ||
      SOURCE.has(extname(path).toLowerCase()) ||
      !extname(path) ||
      (changedSet.has(path) && extname(path).toLowerCase() !== '.md');
    if (!isSource && !inputs.has(path)) continue;
    requireRule(stat.isFile(), `input must be a regular file: ${path}`);
    const input = inputs.get(path);
    if (input) {
      found.add(path);
      requireRule(hash(bytes) === input.sha, `review hash mismatch: ${path}`);
    }
    if (MARKER.test(bytes.toString('utf8')) || changedSet.has(path)) {
      requireRule(
        input,
        `unreviewed integration input ${path}; policy review required (caller flags are not proof). ` +
          `Resolve it by reviewing these bytes and adding one review to ${POLICY} whose inputs ` +
          `bind "${path}" to sha256 ${hash(bytes)}, classified either "non-value" with a ` +
          `justification, or "value-bearing-known-debt" under the approved DEC-CU-22 entry. ` +
          `An entry is that review; never add one to silence the gate.`
      );
    }
  }
  for (const p of inputs.keys()) requireRule(found.has(p), `review input missing: ${p}`);
  console.log(
    `VRF operator-predictable: ${inputs.size} reviewed inputs; ${base ? 'base comparison passed' : 'tree check only; run --base for changed/opaque inputs'}`
  );
}
try {
  main();
} catch (error) {
  console.error(`VRF gate refused: ${error.message}`);
  process.exitCode = 1;
}
