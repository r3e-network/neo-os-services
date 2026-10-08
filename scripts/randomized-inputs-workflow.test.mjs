import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const repoRoot = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const workflowPath = path.join(repoRoot, '.github', 'workflows', 'randomized-inputs.yml');
const workflowText = fs.readFileSync(workflowPath, 'utf8');
// The one command that may run the CU-179 randomized suite in CI. An
// indirection (npm script, wrapper) would let the workflow stay green while the
// suite stopped running, so the contract pins this exact string.
const SUITE_COMMAND =
  'node fuzz-testing/run-services-inputs.mjs "$RUNNER_TEMP/randomized-build.json"';
const BUILD_COMMAND =
  'cargo test --locked -p neo-os-compute --test randomized_inputs --no-run --message-format=json > "$RUNNER_TEMP/randomized-build.json"';

test('randomized-inputs.yml parses and keeps its triggers', () => {
  let parsed;
  assert.doesNotThrow(() => {
    parsed = yaml.load(workflowText, { filename: '.github/workflows/randomized-inputs.yml' });
  }, 'the workflow must be loadable YAML');
  assert.ok(parsed.on.push, 'the suite must run on push');
  assert.ok(parsed.on.pull_request, 'the suite must run on pull requests');
  assert.ok(parsed.jobs['randomized-inputs'], 'the randomized-inputs job must exist');
});

test('the randomized job pins the suite command, its budget and its build', () => {
  const workflow = yaml.load(workflowText);
  const job = workflow.jobs['randomized-inputs'];
  assert.equal(job.if, undefined, 'the job must not be conditional');
  assert.equal(job['continue-on-error'], undefined, 'the job must block on failure');
  const jobTimeout = Number(job['timeout-minutes']);
  assert.ok(
    Number.isFinite(jobTimeout) && jobTimeout >= 10,
    'the job cap must leave room for install and build beyond the suite step'
  );

  const buildIndex = job.steps.findIndex((step) => step.run === BUILD_COMMAND);
  const suiteIndex = job.steps.findIndex((step) => step.run === SUITE_COMMAND);
  assert.ok(buildIndex >= 0, 'the Rust randomized test must be built with the pinned command');
  assert.ok(suiteIndex >= 0, `the suite step must run exactly: ${SUITE_COMMAND}`);
  assert.ok(suiteIndex > buildIndex, 'the suite must run after its build');

  const installIndex = job.steps.findIndex(
    (step) => step.run === 'npm ci --ignore-scripts --no-audit --no-fund'
  );
  assert.ok(installIndex >= 0 && installIndex < suiteIndex, 'workspace imports need npm ci first');

  const suite = job.steps[suiteIndex];
  assert.equal(suite.if, undefined, 'the suite step must not be conditional');
  assert.equal(suite['continue-on-error'], undefined, 'the suite step must block on failure');
  assert.ok(
    Number(suite['timeout-minutes']) <= 1,
    'the suite step must keep the reduced one minute budget'
  );
});

test('the runner fails a run whose suites explored nothing or the wrong seeds', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-179-runner-'));
  const runWith = (script) => {
    const fake = path.join(dir, 'fake-rust-test');
    fs.writeFileSync(fake, script);
    fs.chmodSync(fake, 0o755);
    const log = path.join(dir, 'build.json');
    fs.writeFileSync(
      log,
      `${JSON.stringify({
        reason: 'compiler-artifact',
        target: { name: 'randomized_inputs' },
        executable: fake,
      })}\n`
    );
    return spawnSync(process.execPath, ['fuzz-testing/run-services-inputs.mjs', log, '0'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 120000,
    });
  };
  try {
    const silent = runWith('#!/bin/sh\necho "randomized inputs"\n');
    assert.notEqual(silent.status, 0, 'a Rust suite that explored nothing must fail the run');
    assert.match(silent.stderr, /printed no receipt/);

    const wrongSeeds = runWith(
      `#!/bin/sh\necho 'SERVICES_INPUTS_RECEIPT {"suite":"services-rust","seeds":[{"seed":1,"cases":100}]}'\n`
    );
    assert.notEqual(wrongSeeds.status, 0, 'a receipt for other seeds must fail the run');
    assert.match(wrongSeeds.stderr, /committed seeds/);

    const truncated = runWith(
      `#!/bin/sh\necho 'SERVICES_INPUTS_RECEIPT {"suite":"services-rust","seeds":[{"seed":20261005,"cases":1},{"seed":20260928,"cases":1},{"seed":4294967295,"cases":1}]}'\n`
    );
    assert.notEqual(
      truncated.status,
      0,
      'a receipt that reports almost no explored cases must fail the run'
    );
    assert.match(truncated.stderr, /explored 3 cases/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
