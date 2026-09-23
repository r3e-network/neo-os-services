import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const repoRoot = path.resolve(import.meta.dirname, '..');

// Use the YAML parser already installed in the repository (js-yaml, pulled in
// transitively by eslint/gray-matter) so the regression test adds no new
// dependency and mirrors what tooling that reads workflow files would do.
const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const workflowPath = path.join(repoRoot, '.github', 'workflows', 'env-check.yml');
const workflowText = fs.readFileSync(workflowPath, 'utf8');

test('env-check.yml parses as valid YAML', () => {
  let parsed;
  assert.doesNotThrow(() => {
    parsed = yaml.load(workflowText, { filename: '.github/workflows/env-check.yml' });
  }, 'env-check.yml must be parseable YAML so GitHub Actions can load the workflow');
  assert.ok(parsed && typeof parsed === 'object');
});

test('env-check.yml keeps its intended triggers', () => {
  const parsed = yaml.load(workflowText, { filename: '.github/workflows/env-check.yml' });
  assert.ok(parsed.on, 'workflow must declare its triggers under on:');
  assert.deepEqual(parsed.on.push.branches, ['main', 'develop']);
  assert.deepEqual(parsed.on['pull_request'].branches, ['main', 'develop']);
  assert.equal(parsed.on.workflow_dispatch.inputs.network.type, 'choice');
  assert.deepEqual(parsed.on.workflow_dispatch.inputs.network.options, ['testnet', 'mainnet']);
});

test('env-check.yml keeps its intended jobs and summary gate', () => {
  const parsed = yaml.load(workflowText, { filename: '.github/workflows/env-check.yml' });
  const jobs = parsed.jobs;
  for (const jobId of [
    'validate-network-env',
    'validate-web-app-env',
    'validate-signers',
    'summary',
  ]) {
    assert.ok(jobs[jobId], `job ${jobId} must remain defined`);
    assert.ok(Array.isArray(jobs[jobId].steps) && jobs[jobId].steps.length > 0);
  }
  assert.deepEqual(jobs.summary.needs, [
    'validate-network-env',
    'validate-web-app-env',
    'validate-signers',
  ]);
  assert.equal(jobs.summary['if'], 'always()');
});

test('env-check reports results, not fixed success text', () => {
  const parsed = yaml.load(workflowText, { filename: '.github/workflows/env-check.yml' });
  // The removed report step wrote these lines whatever had happened.
  for (const claim of [
    'Script validation passed',
    'Error handling implemented',
    'Type safety maintained',
    'Key findings',
    'validation complete',
    'check complete',
  ]) {
    assert.ok(
      !workflowText.includes(claim),
      `env-check.yml must not print the fixed claim "${claim}"`
    );
  }
  const networkSteps = parsed.jobs['validate-network-env'].steps;
  assert.ok(
    networkSteps.some((step) => /test:run -- __tests__\/networks\.test\.ts/.test(step.run ?? '')),
    'the network job runs the behavioural networks.ts test'
  );
  for (const [jobId, command] of [
    ['validate-web-app-env', 'check:web-cron-env'],
    ['validate-signers', 'check:signers'],
  ]) {
    const step = parsed.jobs[jobId].steps.find((candidate) =>
      (candidate.run ?? '').includes(command)
    );
    assert.ok(step, `${jobId} still runs ${command}`);
    assert.match(step.name, /\(advisory\)$/, `${jobId} labels ${command} as advisory`);
  }
});
