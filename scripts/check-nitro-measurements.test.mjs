import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  REQUIRED_APP_IDS,
  REPRODUCIBILITY_REQUIRED_FROM,
  BUILD_INPUT_PATHS,
  auditBuildInputManifests,
  auditDebugFlags,
  auditAttestationPins,
  auditManifests,
  auditNitroMeasurements,
  validateManifestSchema,
} from './check-nitro-measurements.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const script = fileURLToPath(new URL('./check-nitro-measurements.mjs', import.meta.url));
const schema = JSON.parse(
  readFileSync(
    new URL('../deploy/nitro/measurements/manifest.schema.json', import.meta.url),
    'utf8'
  )
);

const PCR = (seed) => seed.repeat(96).slice(0, 96);
const ZERO_PCR = '0'.repeat(96);

function manifest(overrides = {}) {
  return {
    release: 'oracle-fixture-2026-09-21.1',
    app_id: 'morpheus-oracle',
    network: 'testnet',
    git_commit: 'a'.repeat(40),
    image_id: `sha256:${'b'.repeat(64)}`,
    eif_sha256: 'c'.repeat(64),
    hash_algorithm: 'SHA384',
    pcr0: PCR('1'),
    pcr1: PCR('2'),
    pcr2: PCR('3'),
    built_at: '2026-06-15T15:29:53Z',
    ...overrides,
  };
}

function keyPolicy(imageSha384) {
  return {
    Version: '2012-10-17',
    Id: 'morpheus-enclave-master',
    Statement: [
      {
        Sid: 'EnclaveAttestedDecrypt',
        Effect: 'Allow',
        Principal: { AWS: 'arn:aws:iam::736326664265:role/MorpheusNitroRelayerInstanceRole' },
        Action: 'kms:Decrypt',
        Resource: '*',
        Condition: {
          StringEqualsIgnoreCase: { 'kms:RecipientAttestation:ImageSha384': imageSha384 },
        },
      },
    ],
  };
}

/** Build a throwaway tree with the same layout the real checker walks. */
function fixture({ manifests = [manifest()], pins = null, policies = {}, files = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'nitro-measurements-'));
  const measurements = join(root, 'deploy', 'nitro', 'measurements');
  const kms = join(root, 'deploy', 'nitro', 'kms');
  mkdirSync(measurements, { recursive: true });
  mkdirSync(kms, { recursive: true });
  mkdirSync(join(root, 'deploy', 'systemd'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  cpSync(
    join(repoRoot, 'deploy', 'nitro', 'measurements', 'manifest.schema.json'),
    join(measurements, 'manifest.schema.json')
  );
  for (const entry of manifests) {
    writeFileSync(
      join(measurements, `${entry.release}.json`),
      `${JSON.stringify(entry, null, 2)}\n`
    );
  }
  const pinDoc = pins ?? {
    required_app_ids: ['morpheus-oracle'],
    pins: [
      {
        app_id: 'morpheus-oracle',
        key_alias: 'alias/morpheus-enclave-master',
        key_arn: 'arn:aws:kms:us-east-1:736326664265:key/5d9b6835-6976-4fd9-92ba-5db5176d7c3a',
        policy_file: 'morpheus-enclave-master.policy.json',
        pinned_release: manifests[0]?.release ?? 'oracle-fixture-2026-09-21.1',
      },
    ],
    unpublished: [],
  };
  writeFileSync(join(kms, 'attestation-pins.json'), `${JSON.stringify(pinDoc, null, 2)}\n`);
  const policyDocs = Object.keys(policies).length
    ? policies
    : { 'morpheus-enclave-master.policy.json': keyPolicy(manifests[0]?.pcr0 ?? PCR('1')) };
  for (const [name, doc] of Object.entries(policyDocs)) {
    writeFileSync(join(kms, name), `${JSON.stringify(doc, null, 2)}\n`);
  }
  for (const [relative, contents] of Object.entries(files)) {
    const target = join(root, relative);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, contents);
  }
  return root;
}

const TODAY = '2026-09-21';

test('the committed repository tree passes the whole gate', () => {
  assert.deepEqual(auditNitroMeasurements(repoRoot, { today: TODAY }), []);
});

test('every committed measurement manifest validates against manifest.schema.json', () => {
  assert.deepEqual(auditManifests(repoRoot), []);
});

test('schema rejects the nitro-cli Debug rendering of the hash algorithm', () => {
  const problems = validateManifestSchema(manifest({ hash_algorithm: 'Sha384 { ... }' }), schema);
  assert.equal(problems.length, 1, problems.join('; '));
  assert.match(problems[0], /hash_algorithm/);
});

test('schema accepts the two provenance objects the build scripts actually emit', () => {
  assert.deepEqual(
    validateManifestSchema(manifest({ vault_profile: { schema: 'x' } }), schema),
    []
  );
  assert.deepEqual(
    validateManifestSchema(manifest({ custody_boundary: { service_url: 'x' } }), schema),
    []
  );
  assert.deepEqual(validateManifestSchema(manifest({ reproducible_verified: true }), schema), []);
});

test('schema still rejects an unknown top-level key', () => {
  const problems = validateManifestSchema(manifest({ smuggled: 1 }), schema);
  assert.equal(problems.length, 1, problems.join('; '));
  assert.match(problems[0], /smuggled/);
});

test('schema accepts morpheus-custody as an app id', () => {
  assert.deepEqual(validateManifestSchema(manifest({ app_id: 'morpheus-custody' }), schema), []);
  assert.equal(validateManifestSchema(manifest({ app_id: 'morpheus-other' }), schema).length, 1);
});

test('a manifest filename that disagrees with its release id is a finding', () => {
  const root = fixture();
  const measurements = join(root, 'deploy', 'nitro', 'measurements');
  writeFileSync(
    join(measurements, 'renamed.json'),
    `${JSON.stringify(manifest({ release: 'oracle-fixture-2026-09-21.1' }), null, 2)}\n`
  );
  const problems = auditManifests(root);
  assert.ok(
    problems.some((problem) => problem.includes('renamed.json')),
    problems.join('; ')
  );
});

test('a post-cutover manifest must declare that its PCRs were re-derived', () => {
  const after = new Date(Date.parse(REPRODUCIBILITY_REQUIRED_FROM) + 86_400_000).toISOString();
  const unverified = fixture({ manifests: [manifest({ built_at: after })] });
  assert.ok(
    auditManifests(unverified).some((problem) => problem.includes('reproducible_verified')),
    'an unverified post-cutover manifest must be refused'
  );
  const verified = fixture({
    manifests: [manifest({ built_at: after, reproducible_verified: true })],
  });
  assert.deepEqual(auditManifests(verified), []);
  const legacy = fixture({ manifests: [manifest({ built_at: '2026-06-15T15:29:53Z' })] });
  assert.deepEqual(auditManifests(legacy), []);
});

test('a key policy whose ImageSha384 differs from the pinned manifest PCR0 is a finding', () => {
  const root = fixture({
    policies: { 'morpheus-enclave-master.policy.json': keyPolicy(PCR('9')) },
  });
  const problems = auditAttestationPins(root, { today: TODAY });
  assert.ok(
    problems.some((problem) => /ImageSha384/.test(problem)),
    problems.join('; ')
  );
});

test('an all-zero ImageSha384 placeholder is refused even though it parses', () => {
  const root = fixture({
    manifests: [manifest({ pcr0: ZERO_PCR })],
    policies: { 'morpheus-enclave-master.policy.json': keyPolicy(ZERO_PCR) },
  });
  const problems = auditAttestationPins(root, { today: TODAY });
  assert.ok(
    problems.some((problem) => /all-zero|placeholder/i.test(problem)),
    problems.join('; ')
  );
});

test('a manifest carrying an all-zero PCR0 is refused', () => {
  const root = fixture({ manifests: [manifest({ pcr0: ZERO_PCR })] });
  const problems = auditManifests(root);
  assert.ok(
    problems.some((problem) => /all-zero|placeholder/i.test(problem)),
    problems.join('; ')
  );
});

test('a pin naming a release with no committed manifest is a finding', () => {
  const root = fixture({
    pins: {
      required_app_ids: ['morpheus-oracle'],
      pins: [
        {
          app_id: 'morpheus-oracle',
          key_alias: 'alias/morpheus-enclave-master',
          key_arn: 'arn:aws:kms:us-east-1:736326664265:key/5d9b6835',
          policy_file: 'morpheus-enclave-master.policy.json',
          pinned_release: 'oracle-does-not-exist',
        },
      ],
      unpublished: [],
    },
  });
  const problems = auditAttestationPins(root, { today: TODAY });
  assert.ok(
    problems.some((problem) => problem.includes('oracle-does-not-exist')),
    problems.join('; ')
  );
});

test('a required app id that is neither pinned nor recorded as unpublished fails closed', () => {
  const root = fixture({
    pins: {
      required_app_ids: ['morpheus-oracle', 'morpheus-custody'],
      pins: [
        {
          app_id: 'morpheus-oracle',
          key_alias: 'alias/morpheus-enclave-master',
          key_arn: 'arn:aws:kms:us-east-1:736326664265:key/5d9b6835',
          policy_file: 'morpheus-enclave-master.policy.json',
          pinned_release: 'oracle-fixture-2026-09-21.1',
        },
      ],
      unpublished: [],
    },
  });
  const problems = auditAttestationPins(root, { today: TODAY });
  assert.ok(
    problems.some((problem) => problem.includes('morpheus-custody')),
    problems.join('; ')
  );
});

test('an unpublished record is accepted while dated, and refused once it expires', () => {
  const record = (requiredBy) => ({
    required_app_ids: ['morpheus-oracle'],
    pins: [],
    unpublished: [
      {
        app_id: 'morpheus-oracle',
        reason: 'the CMK key policy has never been exported from AWS into version control',
        blocked_on: 'aws kms get-key-policy',
        required_by: requiredBy,
        owner: 'platform operator',
      },
    ],
  });
  const live = fixture({ pins: record('2026-10-21'), policies: { 'unused.json': {} } });
  assert.deepEqual(auditAttestationPins(live, { today: TODAY }), []);
  const expired = fixture({ pins: record('2026-09-20'), policies: { 'unused.json': {} } });
  const problems = auditAttestationPins(expired, { today: TODAY });
  assert.ok(
    problems.some((problem) => /required_by|expired|past due/i.test(problem)),
    problems.join('; ')
  );
});

test('an unpublished record without a reason or an owner is refused', () => {
  const root = fixture({
    pins: {
      required_app_ids: ['morpheus-oracle'],
      pins: [],
      unpublished: [{ app_id: 'morpheus-oracle', required_by: '2026-10-21' }],
    },
    policies: { 'unused.json': {} },
  });
  assert.ok(auditAttestationPins(root, { today: TODAY }).length > 0);
});

test('an app id that is both pinned and recorded unpublished is a stale-record finding', () => {
  const root = fixture({
    pins: {
      required_app_ids: ['morpheus-oracle'],
      pins: [
        {
          app_id: 'morpheus-oracle',
          key_alias: 'alias/morpheus-enclave-master',
          key_arn: 'arn:aws:kms:us-east-1:736326664265:key/5d9b6835',
          policy_file: 'morpheus-enclave-master.policy.json',
          pinned_release: 'oracle-fixture-2026-09-21.1',
        },
      ],
      unpublished: [
        {
          app_id: 'morpheus-oracle',
          reason: 'stale leftover',
          blocked_on: 'nothing',
          required_by: '2026-10-21',
          owner: 'platform operator',
        },
      ],
    },
  });
  const problems = auditAttestationPins(root, { today: TODAY });
  assert.ok(
    problems.some((problem) => /both/i.test(problem)),
    problems.join('; ')
  );
});

test('a debug-mode or console-attached launch anywhere in the deploy tree is a finding', () => {
  const clean = fixture();
  assert.deepEqual(auditDebugFlags(clean), []);
  const debugged = fixture({
    files: {
      'deploy/nitro/start-nitro-custody.sh': 'nitro-cli run-enclave --debug-mode --eif-path x\n',
    },
  });
  const problems = auditDebugFlags(debugged);
  assert.ok(
    problems.some((problem) => problem.includes('--debug-mode')),
    problems.join('; ')
  );
  const attached = fixture({
    files: { 'scripts/boot.sh': 'nitro-cli console --attach-console --enclave-id x\n' },
  });
  assert.ok(auditDebugFlags(attached).some((problem) => problem.includes('--attach-console')));
});

test('the committed deploy tree launches no debug-mode enclave', () => {
  assert.deepEqual(auditDebugFlags(repoRoot), []);
});

test('changing a measured build input without adding a manifest is a finding', () => {
  assert.ok(BUILD_INPUT_PATHS.includes('deploy/nitro/Dockerfile.enclave'));
  const changed = ['deploy/nitro/Dockerfile.enclave'];
  const problems = auditBuildInputManifests({ changedFiles: changed, addedFiles: [] });
  assert.ok(
    problems.some((problem) => problem.includes('Dockerfile.enclave')),
    problems.join('; ')
  );
});

test('adding a manifest alongside the build-input change clears the gate', () => {
  const problems = auditBuildInputManifests({
    changedFiles: ['deploy/nitro/Dockerfile.signer', 'deploy/nitro/measurements/custody-x.json'],
    addedFiles: ['deploy/nitro/measurements/custody-x.json'],
  });
  assert.deepEqual(problems, []);
});

test('the schema and the example fixture do not count as a new manifest', () => {
  const problems = auditBuildInputManifests({
    changedFiles: ['Cargo.lock', 'deploy/nitro/measurements/example.json'],
    addedFiles: ['deploy/nitro/measurements/example.json'],
  });
  assert.ok(problems.length > 0, 'example.json must not satisfy the build-input gate');
});

test('an unreachable git_commit on the new manifest is a finding', () => {
  const problems = auditBuildInputManifests({
    changedFiles: ['deploy/nitro/Dockerfile.enclave', 'deploy/nitro/measurements/oracle-x.json'],
    addedFiles: ['deploy/nitro/measurements/oracle-x.json'],
    manifestsByPath: { 'deploy/nitro/measurements/oracle-x.json': { git_commit: 'deadbeef' } },
    isCommitReachable: () => false,
  });
  assert.ok(
    problems.some((problem) => problem.includes('deadbeef')),
    problems.join('; ')
  );
});

test('both enclave app ids are required to publish a measurement', () => {
  assert.deepEqual([...REQUIRED_APP_IDS].sort(), ['morpheus-custody', 'morpheus-oracle']);
});

test('--base drives the build-input rule off a real diff', () => {
  const root = fixture();
  const git = (...args) =>
    spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], {
      cwd: root,
      encoding: 'utf8',
    });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'Cargo.lock'), '# base\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD').stdout.trim();
  writeFileSync(join(root, 'Cargo.lock'), '# moved\n');
  git('add', '-A');
  git('commit', '-qm', 'bump');

  const run = (args) =>
    spawnSync(process.execPath, [script, '--root', root, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
  const withoutManifest = run(['--base', base]);
  assert.equal(withoutManifest.status, 1, withoutManifest.stdout + withoutManifest.stderr);
  assert.match(withoutManifest.stderr, /Cargo\.lock changed but no new manifest/);

  const head = git('rev-parse', 'HEAD').stdout.trim();
  writeFileSync(
    join(root, 'deploy', 'nitro', 'measurements', 'oracle-new.json'),
    `${JSON.stringify(manifest({ release: 'oracle-new', git_commit: head }), null, 2)}\n`
  );
  git('add', '-A');
  git('commit', '-qm', 'measure');
  const withManifest = run(['--base', base]);
  assert.doesNotMatch(withManifest.stderr, /no new manifest was added/);
  assert.doesNotMatch(withManifest.stderr, /not reachable from this branch/);
});

test('the CLI exits 0 on the committed tree and non-zero on a broken one', () => {
  const ok = spawnSync(process.execPath, [script], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const broken = fixture({ manifests: [manifest({ hash_algorithm: 'Sha384 { ... }' })] });
  const bad = spawnSync(process.execPath, [script, '--root', broken], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stderr + bad.stdout, /hash_algorithm/);
});
