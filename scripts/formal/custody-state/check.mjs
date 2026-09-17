#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildModel, buildQueries, decodeTrace } from './model.mjs';
import { parseSExpressions } from './smt-lib.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(directory, '../../..');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

export const SAFETY_IDS = [
  'release-barrier',
  'exact-decision-ledger',
  'cache-current-authority',
  'restore-head-admission',
  'epoch-fencing',
  'monotonic-generation',
  'snapshot-fence-integrity',
  'request-digest-binding',
  'consensus-no-conflicting-release',
];
export const COVER_IDS = [
  'timeout-exact-receipt-release',
  'inflight-commit-after-crash',
  'commit-crash-restore-cache',
  'reject-wrong-commit-receipt',
  'reject-restore-head-race',
  'cancel-does-not-abort-commit',
  'two-owner-takeover',
  'committed-snapshot-takeover',
  'two-requests-output',
];
export const CONTROL_SPECS = [
  { mutation: 'early-release', property: 'release-barrier' },
  { mutation: 'stale-restore-admission', property: 'restore-head-admission' },
  { mutation: 'inexact-receipt', property: 'release-barrier' },
  { mutation: 'omit-audit', property: 'exact-decision-ledger' },
  { mutation: 'omit-fencing', property: 'epoch-fencing' },
  { mutation: 'rewind-generation', property: 'monotonic-generation' },
  { mutation: 'rewind-snapshot-fence', property: 'snapshot-fence-integrity' },
];

function scalar(value) {
  if (value === 'true' || value === 'false') return value === 'true';
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  if (typeof value === 'string' && /^#x[0-9a-f]+$/i.test(value))
    return parseInt(value.slice(2), 16);
  if (typeof value === 'string' && /^#b[01]+$/.test(value)) return parseInt(value.slice(2), 2);
  if (Array.isArray(value) && value.length === 2 && value[0] === '-') return -scalar(value[1]);
  throw new Error('unexpected non-scalar trace value');
}

export function parseSolverOutput(stdout, checks) {
  const expressions = parseSExpressions(stdout);
  let cursor = 0;
  const results = [];
  for (const check of checks) {
    if (expressions[cursor++] !== `CHECK:${check.id}`)
      throw new Error(`missing or reordered identity: ${check.id}`);
    const actual = expressions[cursor++];
    if (!['sat', 'unsat', 'unknown'].includes(actual))
      throw new Error(`missing solver answer: ${check.id}`);
    let values = null;
    if (check.expected === 'sat') {
      const pairs = expressions[cursor++];
      if (
        !Array.isArray(pairs) ||
        !pairs.length ||
        !pairs.every(
          (pair) => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string'
        )
      )
        throw new Error(`missing concrete witness: ${check.id}`);
      values = Object.fromEntries(pairs.map(([name, value]) => [name, scalar(value)]));
      if (Object.keys(values).length !== pairs.length)
        throw new Error(`duplicate witness value: ${check.id}`);
    }
    results.push({
      id: check.id,
      expected: check.expected,
      actual,
      passed: actual === check.expected,
      values,
    });
  }
  if (cursor !== expressions.length) throw new Error('unexpected solver output after final check');
  return results;
}

const references = [
  'crates/nitro-attest/src/session_key.rs',
  'workers/neo-signer/src/bin/signer_service.rs',
  'workers/neo-signer/src/vault_profile.rs',
  'deploy/nitro/Dockerfile.signer',
  'deploy/nitro/build-custody-eif.sh',
  'deploy/custody-state-authority/src/http.mjs',
  'deploy/custody-state-authority/src/snapshot-store.mjs',
  'deploy/custody-state-authority/template.yaml',
  'workers/neo-signer/src/coordinator.rs',
  'workers/neo-signer/src/durable.rs',
  'deploy/custody-state-authority/src/authority.mjs',
  'deploy/custody-state-authority/src/dynamo-repository.mjs',
  'deploy/custody-state-authority/src/protocol.mjs',
  'deploy/custody-state-authority/src/request-proof.mjs',
  'workers/neo-signer/src/service.rs',
  'workers/neo-signer/src/api.rs',
  'workers/neo-signer/src/store/audit.rs',
  'workers/neo-signer/src/store/schema.rs',
  'workers/neo-signer/src/snapshot.rs',
  'workers/neo-signer/src/store/snapshot.rs',
  'crates/nitro-attest/src/kms.rs',
  'docs/reports/custody-durable-state-design-20260911.md',
];
function hashFiles(files, allowMissing = false) {
  return Object.fromEntries(
    files.map((name) => {
      const target = path.join(repository, name);
      return [
        name,
        allowMissing && !fs.existsSync(target) ? null : sha256(fs.readFileSync(target)),
      ];
    })
  );
}

export function runGroup({ bound, mutation, checks, z3, timeoutMs, emitDirectory }) {
  const model = buildModel({ bound, mutation, timeoutMs });
  const specifications = checks(model);
  const smt = buildQueries(model, specifications);
  const started = performance.now();
  const execution = spawnSync(z3, ['-in', '-smt2'], {
    input: smt,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: Math.min(timeoutMs * specifications.length + 5000, 600000),
  });
  const result = {
    mutation,
    bound,
    smtSha256: sha256(smt),
    outputSha256: sha256(execution.stdout ?? ''),
    elapsedMs: Math.round(performance.now() - started),
    exitCode: execution.status,
    passed: false,
    checks: [],
  };
  if (emitDirectory) {
    fs.mkdirSync(emitDirectory, { recursive: true });
    fs.writeFileSync(path.join(emitDirectory, `${mutation}.smt2`), smt);
    fs.writeFileSync(path.join(emitDirectory, `${mutation}.stdout`), execution.stdout ?? '');
    fs.writeFileSync(path.join(emitDirectory, `${mutation}.stderr`), execution.stderr ?? '');
  }
  if (execution.error || execution.status !== 0 || execution.stderr?.trim()) {
    result.error =
      execution.error?.message ?? execution.stderr?.trim() ?? `solver exit ${execution.status}`;
    return result;
  }
  try {
    result.checks = parseSolverOutput(execution.stdout, specifications).map(
      ({ values, ...check }) => {
        if (values && model.traceSymbols.some((name) => !(name in values)))
          throw new Error(`incomplete trace: ${check.id}`);
        return { ...check, ...(values ? { trace: decodeTrace(values, bound) } : {}) };
      }
    );
    result.passed =
      result.checks.length === specifications.length &&
      result.checks.every((check) => check.passed);
  } catch (error) {
    result.error = error.message;
  }
  return result;
}

export function runSuite({
  bound = 14,
  z3 = process.env.NEOOS_Z3 ?? 'z3',
  timeoutMs = 60000,
  emitDirectory = null,
} = {}) {
  const version = spawnSync(z3, ['--version'], { encoding: 'utf8', timeout: 5000 });
  if (version.error || version.status !== 0 || !/^Z3 version \d+\.\d+\.\d+/.test(version.stdout))
    throw new Error(`cannot execute Z3: ${version.error?.message ?? version.stderr}`);
  const modelFiles = [
    'scripts/formal/custody-state/model.mjs',
    'scripts/formal/custody-state/check.mjs',
    'scripts/formal/custody-state/smt-lib.mjs',
  ];
  const modelInputs = hashFiles(modelFiles);
  const before = hashFiles(references);
  const groups = [
    runGroup({
      bound,
      mutation: 'none',
      z3,
      timeoutMs,
      emitDirectory,
      checks: (model) => [
        ...SAFETY_IDS.map((id) => ({ id, expression: model.properties[id], expected: 'unsat' })),
        ...COVER_IDS.map((id) => ({ id, expression: model.covers[id], expected: 'sat' })),
      ],
    }),
  ];
  for (const spec of CONTROL_SPECS)
    groups.push(
      runGroup({
        bound,
        mutation: spec.mutation,
        z3,
        timeoutMs,
        emitDirectory,
        checks: (model) => [
          {
            id: `control-${spec.mutation}`,
            expression: model.properties[spec.property],
            expected: 'sat',
          },
        ],
      })
    );
  const after = hashFiles(references);
  const modelInputsAfter = hashFiles(modelFiles);
  const modelDrift = JSON.stringify(modelInputs) !== JSON.stringify(modelInputsAfter);
  const runtimeDrift = JSON.stringify(before) !== JSON.stringify(after);
  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    scope: 'abstract-protocol-bounded-model-only',
    implementationProved: false,
    productionReady: false,
    ok: !modelDrift && !runtimeDrift && groups.every((group) => group.passed),
    solver: version.stdout.trim(),
    bound,
    owners: 2,
    requests: 2,
    consensusSlots: 1,
    digests: 2,
    modelInputsSha256: modelInputs,
    modelInputsSha256After: modelInputsAfter,
    modelDriftDuringRun: modelDrift,
    runtimeReferenceSha256Before: before,
    runtimeReferenceSha256After: after,
    runtimeReferenceDriftDuringRun: runtimeDrift,
    assumptions: [
      'Authenticated immutable profile, exact AEAD/hash/object identity and remote receipts are ideal trusted primitives.',
      'Coordinator serializes CAS/lease expiry, never rolls back HEAD or changes committed objects; parent cannot mutate it.',
      'Enclave code follows transitions; each owner serializes local mutations; boot/session identity is abstracted by monotonically acquired epochs.',
      'A full snapshot atomically contains the modeled authorization, request result, audit, spend marker and consensus reservation.',
      'Generation/epoch/hash use eight-bit unsigned values; <=40 transitions cannot overflow; each prepare has a unique abstract ciphertext hash and commit id.',
      'Lease expiry is a nondeterministic trusted coordinator event; no timing/fairness/liveness guarantee is proved.',
    ],
    exclusions: [
      'No production CAS/coordinator implementation exists in this model; no Rust/SQLite/AWS implementation refinement is established.',
      'No cryptographic, IAM, NSM/COSE, schema-parser, nonce-uniqueness or full SQLite content proof.',
      'No monetary arithmetic, gas reward, smart-contract, network transport or blockchain finality proof.',
      'No unbounded theorem or exhaustive arbitrary-length execution proof; SAT reachability covers are not liveness proofs.',
    ],
    groups,
  };
  if (emitDirectory)
    fs.writeFileSync(
      path.join(emitDirectory, 'result.json'),
      `${JSON.stringify(result, null, 2)}\n`
    );
  return result;
}

function main() {
  const options = {};
  const args = process.argv.slice(2);
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--json') json = true;
    else if (args[i] === '--bound') options.bound = Number(args[++i]);
    else if (args[i] === '--z3') options.z3 = args[++i];
    else if (args[i] === '--timeout-ms') options.timeoutMs = Number(args[++i]);
    else if (args[i] === '--emit') options.emitDirectory = path.resolve(args[++i]);
    else throw new Error(`unknown option: ${args[i]}`);
  }
  const result = runSuite(options);
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(
      `${result.ok ? 'PASS' : 'FAIL'}: custody protocol, ${result.solver}, bound=${result.bound}`
    );
    for (const group of result.groups) {
      console.log(`${group.mutation}: ${group.passed ? 'PASS' : 'FAIL'} (${group.elapsedMs} ms)`);
      for (const check of group.checks)
        console.log(`  ${check.id}: ${check.actual} (expected ${check.expected})`);
      if (group.error) console.log(`  ${group.error}`);
    }
    console.log('Abstract bounded model only; implementationProved=false; productionReady=false.');
  }
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
