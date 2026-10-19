import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const workflow = yaml.load(
  readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
);

for (const [file, jobName] of [
  ['ci.yml', 'lint-and-format'],
  ['ci.yml', 'measurements'],
  ['gitleaks.yml', 'scan'],
]) {
  test(`${file}/${jobName} checks out reachable history for its gates`, (t) => {
    const doc = yaml.load(
      readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8')
    );
    const job = doc.jobs[jobName];
    const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    assert.ok(checkout, 'history consumer must check out the repository');
    assert.equal(checkout.if, undefined);
    assert.equal(checkout['continue-on-error'], undefined);
    assert.ok(job.steps.indexOf(checkout) < job.steps.findIndex((step) => step.run));

    const root = mkdtempSync(join(tmpdir(), 'ci-history-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const git = (...args) =>
      execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    git('init', '-q', '-b', 'main', 'source');
    const commit = (text) => {
      writeFileSync(join(root, 'source', 'input'), text);
      git('-C', 'source', 'add', 'input');
      git(
        '-C',
        'source',
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-qm',
        text
      );
      return git('-C', 'source', 'rev-parse', 'HEAD');
    };
    const ancestor = commit('reviewed ancestor');
    commit('current source');
    // checkout defaults to one commit; file:// makes Git honor depth locally.
    const depth = checkout.with?.['fetch-depth'] ?? 1;
    git(
      'clone',
      ...(depth === 0 ? [] : ['--depth', String(depth)]),
      pathToFileURL(join(root, 'source')).href,
      'checkout'
    );
    assert.equal(
      git('-C', 'checkout', 'rev-parse', '--is-shallow-repository'),
      'false',
      'history gate needs a full checkout'
    );
    git('-C', 'checkout', 'merge-base', '--is-ancestor', ancestor, 'HEAD');
    assert.ok(
      !job.steps.some((step) => /git fetch[^\n]*--depth(?:[= ]|$)/.test(step.run ?? '')),
      'later fetches must not reintroduce shallow boundaries'
    );
  });
}

function requiredRun(job, command) {
  const step = job.steps.find((candidate) => candidate.run === command);
  assert.ok(step, `missing CI command: ${command}`);
  assert.equal(step.if, undefined, `${command} must not be conditional`);
  assert.equal(step['continue-on-error'], undefined, `${command} must block on failure`);
  return job.steps.indexOf(step);
}

test('ops prepares the shared enclave binary before timed parallel fixtures', () => {
  const job = workflow.jobs['web-and-worker'];
  const command =
    'cargo build --locked --offline --jobs 1 -p nitro-enclave-host --bin enclave_host';
  const build = job.steps.find((step) => step.run === command);
  assert.ok(build, 'cold enclave compilation needs a separate bounded preparation step');
  const fetch = job.steps.find((step) => step.run === 'cargo fetch --locked');
  const tests = job.steps.find((step) => step.run === 'npm run test:ops');
  for (const step of [fetch, build, tests]) {
    assert.equal(step.if, "matrix.suite == 'ops'");
    assert.equal(step['continue-on-error'], undefined);
    assert.equal(step['working-directory'], undefined, 'all steps use the same target directory');
    assert.equal(step.env, undefined, 'preparation and fixtures use the same Cargo profile');
  }
  assert.ok(job.steps.indexOf(fetch) < job.steps.indexOf(build));
  assert.ok(job.steps.indexOf(build) < job.steps.indexOf(tests));
  assert.ok(
    Number.isInteger(build['timeout-minutes']) &&
      build['timeout-minutes'] > 0 &&
      build['timeout-minutes'] <= 20
  );
});

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
  assert.match(shrink.run, /git fetch --no-tags origin "\$BASE_SHA"/);
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
  assert.deepEqual(custody.needs, ['runner', 'changes']);
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
