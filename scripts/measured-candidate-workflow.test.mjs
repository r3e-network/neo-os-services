import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const yaml = createRequire(import.meta.url)('js-yaml');
const file = new URL('../.github/workflows/measured-candidate.yml', import.meta.url);
const admission =
  "github.repository == 'r3e-network/neo-os-services' && toJSON(github.event.repository.private) == 'false' && github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch'";
const env = {
  CANDIDATE_SOURCE_SHA: '${{ inputs.source_sha }}',
  PUBLIC_BUNDLE_SHA256: '${{ inputs.public_bundle_sha256 }}',
  PUBLIC_BUNDLE_BASE64: '${{ inputs.public_bundle_base64 }}',
  CANDIDATE_REPOSITORY_PRIVATE: '${{ toJSON(github.event.repository.private) }}',
};
const artifactFiles = ['enclave.eif', 'build-evidence.json', 'hosted-evidence.json', 'SHA256SUMS'];

function keys(value, expected) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
}

function load() {
  assert.ok(existsSync(file), 'manual measured candidate workflow must exist');
  return yaml.load(readFileSync(file, 'utf8'));
}

// This deliberately admits one reviewed job shape, not a general workflow DSL.
// New steps, environment sources or upload paths require a corresponding review.
function check(w) {
  keys(w, ['name', 'on', 'permissions', 'concurrency', 'jobs']);
  assert.equal(w.name, 'measured-candidate');
  keys(w.on, ['workflow_dispatch']);
  keys(w.on.workflow_dispatch, ['inputs']);
  keys(w.on.workflow_dispatch.inputs, [
    'source_sha',
    'public_bundle_sha256',
    'public_bundle_base64',
  ]);
  for (const input of Object.values(w.on.workflow_dispatch.inputs)) {
    keys(input, ['description', 'required', 'type']);
    assert.equal(input.required, true);
    assert.equal(input.type, 'string');
    assert.equal(typeof input.description, 'string');
  }
  assert.deepEqual(w.permissions, { contents: 'read' });
  assert.deepEqual(w.concurrency, { group: 'measured-candidate', 'cancel-in-progress': false });
  keys(w.jobs, ['measured-candidate']);
  const job = w.jobs['measured-candidate'];
  keys(job, ['if', 'runs-on', 'timeout-minutes', 'steps']);
  assert.equal(job.if, admission);
  assert.equal(job['runs-on'], 'ubuntu-24.04');
  assert.equal(job['timeout-minutes'], 330);
  assert.equal(job.steps.length, 3);
  const [checkout, build, upload] = job.steps;
  assert.deepEqual(checkout, {
    uses: 'actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd',
    with: { 'persist-credentials': false, 'fetch-depth': 0 },
  });
  keys(build, ['name', 'id', 'env', 'run']);
  assert.equal(build.id, 'candidate');
  assert.deepEqual(build.env, env);
  assert.equal(build.run, 'python3 -B scripts/hosted_native_candidate.py');
  keys(upload, ['name', 'if', 'uses', 'with']);
  assert.equal(upload.if, "success() && steps.candidate.outputs.verified == 'true'");
  assert.equal(upload.uses, 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02');
  assert.deepEqual(upload.with, {
    name: 'measured-candidate-${{ github.run_id }}-${{ github.run_attempt }}',
    path:
      artifactFiles.map((name) => '${{ steps.candidate.outputs.path }}/' + name).join('\n') + '\n',
    'if-no-files-found': 'error',
    'retention-days': 1,
    'compression-level': 0,
  });
}

test('measured candidate is a bounded public manual job with success-only selected artifacts', () => {
  check(load());
});

// Model only the documented Actions privacy comparison, never eval an expression.
// Actions loose equality converts null/empty strings/false to numeric zero.
function privacyAdmitted(expression, value) {
  if (expression.includes("toJSON(github.event.repository.private) == 'false'")) {
    return JSON.stringify(value ?? null) === 'false';
  }
  assert.ok(expression.includes('github.event.repository.private == false'));
  if (typeof value === 'boolean') return value === false;
  if (value === undefined || value === null || value === '') return true;
  if (typeof value === 'number') return value === 0;
  return false;
}

test('privacy admission requires an explicit boolean false', () => {
  const expression = load().jobs['measured-candidate'].if;
  assert.equal(privacyAdmitted(expression, false), true);
  for (const value of [undefined, null, '', 0, 'false', true]) {
    assert.equal(privacyAdmitted(expression, value), false, `privacy value: ${String(value)}`);
  }
});

test('privacy environment preserves the JSON type for the process-level gate', () => {
  assert.equal(
    load().jobs['measured-candidate'].steps[1].env.CANDIDATE_REPOSITORY_PRIVATE,
    '${{ toJSON(github.event.repository.private) }}'
  );
});

test('hosted job reserves time beyond the declared build stage budgets', () => {
  // Reviewed stage caps: downloads, Rust pull, Cargo fetch, native compile,
  // and two business builds. Reserve another 30 minutes for setup, readback
  // and upload; actual hosted capacity and duration still need measurement.
  const stageSeconds = 900 + 600 + 1200 + 3600 + 11500;
  const reserveSeconds = 1800;
  assert.ok(
    load().jobs['measured-candidate']['timeout-minutes'] * 60 >= stageSeconds + reserveSeconds
  );
});

const mutations = [
  ['push trigger', (w) => (w.on.push = { branches: ['main'] })],
  ['fork trigger', (w) => (w.on.pull_request_target = {})],
  ['write permission', (w) => (w.permissions.contents = 'write')],
  ['OIDC permission', (w) => (w.permissions['id-token'] = 'write')],
  ['extra job', (w) => (w.jobs.other = structuredClone(w.jobs['measured-candidate']))],
  ['cancel active build', (w) => (w.concurrency['cancel-in-progress'] = true)],
  ['self-hosted', (w) => (w.jobs['measured-candidate']['runs-on'] = 'self-hosted')],
  [
    'missing public admission',
    (w) => (w.jobs['measured-candidate'].if = "github.ref == 'refs/heads/main'"),
  ],
  ['unbounded job', (w) => delete w.jobs['measured-candidate']['timeout-minutes']],
  [
    'persistent checkout token',
    (w) => (w.jobs['measured-candidate'].steps[0].with['persist-credentials'] = true),
  ],
  ['mutable action', (w) => (w.jobs['measured-candidate'].steps[0].uses = 'actions/checkout@main')],
  [
    'secret environment',
    (w) =>
      (w.jobs['measured-candidate'].steps[1].env.AWS_SECRET_ACCESS_KEY =
        '${{ secrets.AWS_SECRET_ACCESS_KEY }}'),
  ],
  [
    'shell input interpolation',
    (w) => (w.jobs['measured-candidate'].steps[1].run += ' ${{ inputs.source_sha }}'),
  ],
  [
    'ignored build failure',
    (w) => (w.jobs['measured-candidate'].steps[1]['continue-on-error'] = true),
  ],
  [
    'cache restoration',
    (w) => w.jobs['measured-candidate'].steps.splice(1, 0, { uses: 'actions/cache@main' }),
  ],
  ['failed upload', (w) => (w.jobs['measured-candidate'].steps[2].if = 'always()')],
  ['missing verification', (w) => (w.jobs['measured-candidate'].steps[2].if = 'success()')],
  ['whole workspace upload', (w) => (w.jobs['measured-candidate'].steps[2].with.path = '**/*')],
  [
    'missing artifacts ignored',
    (w) => (w.jobs['measured-candidate'].steps[2].with['if-no-files-found'] = 'warn'),
  ],
  ['long retention', (w) => (w.jobs['measured-candidate'].steps[2].with['retention-days'] = 90)],
];

for (const [name, mutate] of mutations) {
  test(`measured workflow refuses ${name}`, () => {
    const workflow = load();
    check(workflow);
    mutate(workflow);
    assert.throws(() => check(workflow), { name: 'AssertionError' });
  });
}
