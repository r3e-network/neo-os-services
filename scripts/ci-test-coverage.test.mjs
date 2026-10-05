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

test('lint-and-format runs the capability route-parity gate, and compares its baseline with the base on a pull request', () => {
  const lint = workflow.jobs['lint-and-format'];
  const topology = requiredRun(lint, 'npm run check:production-topology');
  const parity = requiredRun(lint, 'npm run check:capability-route-parity');
  assert.equal(parity, topology + 1, 'the gate sits right after the topology gate');

  const shrink = lint.steps.find(
    (step) => typeof step.run === 'string' && step.run.includes('check:capability-route-parity --')
  );
  assert.ok(shrink, 'a step compares the baseline with the base commit');
  assert.equal(shrink.if, "github.event_name == 'pull_request'");
  assert.equal(shrink['continue-on-error'], undefined, 'the comparison must block on failure');
  assert.equal(shrink.env.BASE_SHA, '${{ github.event.pull_request.base.sha }}');
  assert.match(shrink.run, /git fetch --no-tags --depth=1 origin "\$BASE_SHA"/);
  assert.match(shrink.run, /npm run check:capability-route-parity -- --base "\$BASE_SHA"/);
  assert.ok(
    shrink.run.indexOf('git fetch') < shrink.run.indexOf('npm run check:capability-route-parity'),
    'the base commit is fetched before the comparison reads it'
  );
  assert.ok(lint.steps.indexOf(shrink) > parity, 'the comparison follows the gate itself');
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
