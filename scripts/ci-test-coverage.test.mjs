import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const workflow = yaml.load(
  readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
);

function requiredRun(job, command) {
  const step = job.steps.find((candidate) => candidate.run === command);
  assert.ok(step, `missing CI command: ${command}`);
  assert.equal(step.if, undefined, `${command} must not be conditional`);
  assert.equal(step['continue-on-error'], undefined, `${command} must block on failure`);
  return job.steps.indexOf(step);
}

test('lint-and-format runs all scripts regressions before repository gates', () => {
  const lint = workflow.jobs['lint-and-format'];
  assert.equal(lint.if, undefined);
  assert.equal(lint['continue-on-error'], undefined);
  const install = requiredRun(lint, 'npm ci');
  const tests = requiredRun(lint, 'npm run test:scripts');
  assert.equal(tests, install + 1);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(
    pkg.scripts['test:scripts'],
    'node --test scripts/*.test.mjs scripts/lib/tracked-build-outputs.test.mjs'
  );
});

test('CI installs and tests the independent custody authority package', () => {
  const custody = workflow.jobs['custody-state-authority'];
  assert.ok(custody, 'ci.yml must define a custody-state-authority test job');
  assert.equal(custody['continue-on-error'], undefined);
  assert.equal(custody.needs, 'changes');
  assert.equal(
    custody.if,
    "${{ github.event_name == 'push' || needs.changes.outputs.code == 'true' }}"
  );
  const install = requiredRun(custody, 'npm --prefix deploy/custody-state-authority ci');
  assert.equal(
    requiredRun(custody, 'npm --prefix deploy/custody-state-authority test'),
    install + 1
  );
  const filter = workflow.jobs.changes.steps.find((step) => step.id === 'filter');
  const paths = yaml.load(filter.with.filters).code;
  assert.ok(paths.includes('deploy/**'), 'custody changes must select the test job');
  assert.ok(paths.includes('.github/workflows/**'), 'workflow changes must select the test job');
});
