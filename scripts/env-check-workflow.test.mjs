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

test('report heredoc stays inside the run block so shell semantics are preserved', () => {
  const parsed = yaml.load(workflowText, { filename: '.github/workflows/env-check.yml' });
  const step = parsed.jobs['validate-network-env'].steps.find(
    (candidate) => candidate.name === 'Generate Validation Report'
  );
  assert.ok(step, 'Generate Validation Report step must exist');
  assert.match(step.run, /cat > "\$REPORT_FILE" << EOF\n/);
  // The heredoc terminator must be the last line before subsequent shell
  // commands, aligned with the cat command (YAML strips the block's common
  // indentation, so the parsed run script contains no leading spaces).
  assert.match(step.run, /\nEOF\n/);
  assert.match(step.run, /MORPHEUS_NETWORK: Required/);
  assert.match(step.run, /NEXT_PUBLIC_MORPHEUS_NETWORK: Required \(alternative\)/);
});
