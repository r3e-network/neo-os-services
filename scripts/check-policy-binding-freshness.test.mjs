// A dependency bump invalidates every policy binding whose bytes it changes. These
// tests pin that the invalidation is reported by the change that causes it: the
// companion check names every stale binding in one run, says whether this change
// caused it or inherited it, and runs in CI above the steps that could mask it.
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const check = resolve(repoRoot, 'scripts/check-policy-binding-freshness.mjs');
const gate = resolve(repoRoot, 'scripts/check-vrf-consumers.mjs');
const policyPath = 'baselines/vrf-consumers.json';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const MARKED = 'fetch("/vrf/random");';

// A git repository whose policy binds one marked file at its own hash: the shape
// both the VRF gate and this check accept.
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'policy-binding-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  const put = (p, s) => {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), s);
    git('add', p);
  };
  const review = {
    consumer: 'probe',
    classification: 'non-value',
    owner: 'services lead',
    justification: 'Probe displays bytes only; no stake, reward or economic settlement.',
    inputs: { 'probe.mjs': { sha256: sha(MARKED) } },
  };
  const policy = { version: 1, reviews: [review] };
  const save = () => put(policyPath, JSON.stringify(policy));
  put('probe.mjs', MARKED);
  save();
  const commit = (subject) =>
    git('-c', 'user.name=Jimmy', '-c', 'user.email=jimmy@r3e.network', 'commit', '-qm', subject);
  commit('test: seed fixture');
  const run = (...args) =>
    spawnSync(process.execPath, [check, '--root', root, ...args], { encoding: 'utf8' });
  const runGate = (...args) =>
    spawnSync(process.execPath, [gate, '--root', root, ...args], { encoding: 'utf8' });
  return { root, put, policy, review, save, commit, run, runGate, git };
}
const output = (result) => result.stdout + result.stderr;
function red(result) {
  assert.equal(result.status, 1, output(result));
  return output(result);
}

test('a fresh policy passes and counts every binding it checked', (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, output(result));
  assert.match(output(result), /policy bindings fresh: 1 checked/);
});

test('a change that edits a bound file is named as the cause of the staleness', (t) => {
  // The row's defect: a dependency bump stales a binding and the refusal lands on
  // the next unrelated branch. The bump's own run must name the binding, both
  // hashes, the owning review and the remedy.
  const f = fixture(t);
  const bumped = `${MARKED}\n// bumped\n`;
  f.put('probe.mjs', bumped);
  f.commit('fix(deps): bump the bound file');
  const message = red(f.run('--base', 'HEAD~1'));
  assert.match(message, /policy binding stale \(caused by this change\): probe\.mjs/);
  assert.match(message, /probe \(owner: services lead\)/);
  assert.ok(message.includes(sha(MARKED)), 'the reviewed hash is not reported');
  assert.ok(message.includes(sha(bumped)), 'the current hash is not reported');
  assert.ok(message.includes(policyPath), `the remedy does not name ${policyPath}`);
  assert.match(message, /refreshing a hash is a review of the diff/);
  assert.match(message, /refused: 1 caused by this change, 0 inherited, 0 with no file/);
});

test('a binding already stale at the base is reported as inherited, not as caused here', (t) => {
  // The complement: a branch that inherits a red must be able to say it is not its
  // own, which is the whole cost CU-229 measured.
  const f = fixture(t);
  f.put('probe.mjs', `${MARKED}\n// staled by an earlier commit\n`);
  f.commit('chore: stale the binding');
  f.put('unrelated.mjs', 'export const unrelated = 1;\n');
  f.commit('feat: an unrelated change');
  const message = red(f.run('--base', 'HEAD~1'));
  assert.match(message, /policy binding stale \(already stale at HEAD~1/);
  assert.match(message, /not caused by this change\): probe\.mjs/);
  assert.doesNotMatch(message, /\(caused by this change\): probe\.mjs/);
  assert.match(message, /refused: 0 caused by this change, 1 inherited, 0 with no file/);
});

test('every stale binding is reported in one run, not just the first', (t) => {
  // The VRF gate throws on the first problem, so clearing it costs one round per
  // stale binding. One run must name them all.
  const f = fixture(t);
  f.review.inputs['second.mjs'] = { sha256: sha(MARKED) };
  f.put('second.mjs', MARKED);
  f.save();
  f.commit('test: bind a second input');
  f.put('probe.mjs', `${MARKED}\n// one\n`);
  f.put('second.mjs', `${MARKED}\n// two\n`);
  f.commit('fix(deps): bump both bound files');
  const message = red(f.run('--base', 'HEAD~1'));
  assert.match(message, /stale \(caused by this change\): probe\.mjs/);
  assert.match(message, /stale \(caused by this change\): second\.mjs/);
  assert.match(message, /refused: 2 caused by this change, 0 inherited, 0 with no file/);
});

test('a binding whose file is gone is reported with the removal remedy', (t) => {
  const f = fixture(t);
  f.git('rm', '-q', 'probe.mjs');
  f.commit('chore: delete the bound file');
  const message = red(f.run('--base', 'HEAD~1'));
  assert.match(message, /policy binding stale \(no file in the tree\): probe\.mjs/);
  assert.match(message, /delete the "probe\.mjs" binding/);
  assert.match(message, /refused: 0 caused by this change, 0 inherited, 1 with no file/);
});

test('tree mode reports the staleness and says attribution needs a base', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'probe.mjs'), `${MARKED}\n// local edit\n`);
  const message = red(f.run());
  assert.match(message, /policy binding stale \(attribution needs --base\): probe\.mjs/);
  assert.doesNotMatch(message, /caused by this change\)/);
});

test('an unreadable policy refuses instead of reporting zero stale bindings', (t) => {
  for (const [name, body] of [
    ['malformed json', '{ not json'],
    ['wrong version', JSON.stringify({ version: 2, reviews: [] })],
    ['reviews not an array', JSON.stringify({ version: 1, reviews: {} })],
    ['binding without a hash', JSON.stringify({ version: 1, reviews: [{ inputs: { a: {} } }] })],
  ]) {
    const f = fixture(t);
    writeFileSync(join(f.root, policyPath), body);
    const message = red(f.run());
    assert.match(message, /policy binding freshness refused/, name);
    assert.match(message, /check-vrf-consumers\.mjs owns policy validation/, name);
  }
});

test('the check accepts every binding the VRF gate accepts on the same fixture', (t) => {
  // The check must not be able to redden a head the authority would pass: it
  // reports one refusal class the gate already owns, and adds nothing of its own.
  const f = fixture(t);
  const gateResult = f.runGate();
  assert.equal(gateResult.status, 0, output(gateResult));
  const result = f.run();
  assert.equal(result.status, 0, output(result));
});

test('this repository has no stale policy binding at this head', () => {
  const result = spawnSync(process.execPath, [check], { encoding: 'utf8', cwd: repoRoot });
  assert.equal(result.status, 0, output(result));
  assert.match(output(result), /policy bindings fresh: \d+ checked/);
});

test('invalid arguments are refused', (t) => {
  const f = fixture(t);
  for (const args of [['--base'], ['--unknown', 'x'], ['probe.mjs'], ['--base', '--root']]) {
    assert.equal(f.run(...args).status, 1, args.join(' '));
  }
  assert.equal(red(f.run('--base', 'no-such-ref')).includes('base must resolve'), true);
});

test('CI runs the freshness check above every step that could mask it', () => {
  // A check that cannot run because an unrelated gate failed first does not report
  // in the causing change. The audit gate is red on this head for three advisories
  // it did not introduce, and the lockfile-drift step rewrites package-lock.json in
  // place, so the freshness check has to precede both.
  const workflow = yaml.load(
    readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  );
  const lint = workflow.jobs['lint-and-format'];
  const step = lint.steps.find(
    (candidate) =>
      typeof candidate.run === 'string' &&
      candidate.run.includes('scripts/check-policy-binding-freshness.mjs')
  );
  assert.ok(step, 'lint-and-format does not run the policy binding freshness check');
  assert.equal(step.if, undefined, 'the freshness check must not be conditional');
  assert.equal(step['continue-on-error'], undefined, 'the freshness check must block on failure');
  const at = lint.steps.indexOf(step);
  const index = (needle) =>
    lint.steps.findIndex(
      (candidate) => typeof candidate.run === 'string' && candidate.run.includes(needle)
    );
  for (const needle of [
    'npm run check:npm-audit',
    'npm install --package-lock-only',
    'node scripts/check-vrf-consumers.mjs',
  ]) {
    const other = index(needle);
    assert.ok(other > 0, `lint-and-format no longer runs ${needle}`);
    assert.ok(at < other, `the freshness check must run before ${needle}`);
  }
});

test('the pull-request form fetches the base commit and passes it as --base', () => {
  const workflow = yaml.load(
    readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  );
  const lint = workflow.jobs['lint-and-format'];
  const step = lint.steps.find(
    (candidate) =>
      typeof candidate.run === 'string' &&
      candidate.run.includes('scripts/check-policy-binding-freshness.mjs')
  );
  assert.match(step.env.BASE_SHA, /github\.event\.pull_request\.base\.sha/);
  assert.ok(
    step.run.indexOf('git fetch') < step.run.indexOf('--base'),
    'the base commit must be fetched before it is compared'
  );
  assert.match(step.run, /--base "\$BASE_SHA"/);
});

test('a bound file that is not a regular file is refused, not followed', (t) => {
  const f = fixture(t);
  unlinkSync(join(f.root, 'probe.mjs'));
  mkdirSync(join(f.root, 'probe.mjs'));
  const message = red(f.run());
  assert.match(message, /policy binding stale \(no file in the tree\): probe\.mjs/);
});
