import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const directory = new URL('../.github/workflows/', import.meta.url);
const workflows = readdirSync(directory).filter((file) => /\.ya?ml$/.test(file));
const hostedOnly = new Set(['randomized-inputs.yml/randomized-inputs', 'runner-policy.yml/select']);

// Narrow Actions-expression interpreter for the syntax used by runner policies.
// String equality is case-insensitive; mixed primitive types coerce to numbers.
// Unsupported syntax fails closed. Never evaluate an Actions expression as JS.
function actionsValue(source, context) {
  assert.ok(source.startsWith('${{') && source.endsWith('}}'));
  const expression = source.slice(3, -2).trim();
  const tokens = [];
  const lexer =
    /\s*('(?:[^']|'')*'|[a-zA-Z_][a-zA-Z_0-9]*(?:\.[a-zA-Z_][a-zA-Z_0-9]*)*|==|&&|\|\||[(),]|-?\d+(?:\.\d+)?)/y;
  let offset = 0;
  while (offset < expression.length) {
    lexer.lastIndex = offset;
    const match = lexer.exec(expression);
    assert.ok(match, `unsupported expression at ${expression.slice(offset)}`);
    tokens.push(match[1]);
    offset = lexer.lastIndex;
  }
  let at = 0;
  function number(value) {
    if (value === null) return 0;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'number') return value;
    if (typeof value !== 'string') return NaN;
    if (value.trim() === '') return 0;
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === 'number' ? parsed : NaN;
    } catch {
      return NaN;
    }
  }
  function equal(left, right) {
    if (typeof left === 'string' && typeof right === 'string') {
      return left.toUpperCase() === right.toUpperCase();
    }
    if (typeof left === typeof right && (left === null) === (right === null)) return left === right;
    return number(left) === number(right);
  }
  function primary() {
    const token = tokens[at++];
    assert.notEqual(token, undefined, 'incomplete expression');
    if (token === '(') {
      const value = or();
      assert.equal(tokens[at++], ')');
      return value;
    }
    if (token.startsWith("'")) return token.slice(1, -1).replaceAll("''", "'");
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;
    if (/^-?\d/.test(token)) return Number(token);
    if (token === 'format') {
      assert.equal(tokens[at++], '(');
      const template = or();
      assert.equal(tokens[at++], ',');
      const value = or();
      assert.equal(tokens[at++], ')');
      assert.equal(template, 'refs/heads/{0}');
      return `refs/heads/${value}`;
    }
    assert.match(token, /^(github|needs|jobs|steps)\./);
    return token.split('.').reduce((value, key) => value?.[key] ?? null, context);
  }
  function comparison() {
    let value = primary();
    while (tokens[at] === '==') {
      at++;
      value = equal(value, primary());
    }
    return value;
  }
  function and() {
    let value = comparison();
    while (tokens[at] === '&&') {
      at++;
      const right = comparison();
      value = value ? right : value;
    }
    return value;
  }
  function or() {
    let value = and();
    while (tokens[at] === '||') {
      at++;
      const right = and();
      value = value ? value : right;
    }
    return value;
  }
  const result = or();
  assert.equal(at, tokens.length, 'unconsumed expression');
  return result;
}

test('Actions equality ignores string case and retains primitive coercions', () => {
  for (const expression of [
    "'push' == 'PUSH'",
    "'refs/heads/main' == 'refs/heads/MAIN'",
    'null == false',
    "'1' == true",
    "'' == 0",
  ]) {
    assert.equal(actionsValue('${{ ' + expression + ' }}', {}), true, expression);
  }
  assert.equal(actionsValue("${{ 'not-a-number' == 0 }}", {}), false);
  const github = { event_name: 'push' };
  assert.equal(actionsValue("${{ github.event_name == 'PUSH' }}", { github }), true);
});

const selector = yaml.load(readFileSync(new URL('runner-policy.yml', directory), 'utf8'));
const selectionJob = selector.jobs.select;
const selectionStep = selectionJob.steps[0];
const cases = [];
for (const defaultBranch of ['main', 'trunk', 'Release/V1']) {
  for (const privacy of [true, false, null, undefined]) {
    for (const eventName of [
      'push',
      'workflow_dispatch',
      'pull_request',
      'pull_request_target',
      'schedule',
      'workflow_run',
      'repository_dispatch',
      'release',
      'merge_group',
      'PUSH',
      'WORKFLOW_DISPATCH',
    ]) {
      for (const ref of [
        `refs/heads/${defaultBranch}`,
        `refs/heads/${defaultBranch.toUpperCase()}`,
        `REFS/HEADS/${defaultBranch}`,
        'refs/heads/feature',
        'refs/tags/v1',
      ]) {
        const repository = { default_branch: defaultBranch };
        if (privacy !== undefined) repository.private = privacy;
        cases.push({ event_name: eventName, ref, event: { repository } });
      }
    }
  }
}
// Environment values remain data even if they contain Python/shell-looking text.
for (const branch of ["main'; raise RuntimeError('interpolated') #", '$(exit 99)', '']) {
  cases.push({
    event_name: 'push',
    ref: `refs/heads/${branch}`,
    event: { repository: { private: true, default_branch: branch } },
  });
}
function expected(github) {
  const repository = github.event.repository;
  return repository.private === true &&
    (github.event_name === 'workflow_dispatch' ||
      (github.event_name === 'push' &&
        repository.default_branch !== '' &&
        github.ref === `refs/heads/${repository.default_branch}`))
    ? 'neoos-isolated-linux'
    : 'ubuntu-latest';
}

let selected;
function selectedRunners() {
  if (selected) return selected;
  const environments = cases.map((github) =>
    Object.fromEntries(
      Object.entries(selectionStep.env).map(([name, expression]) => {
        const value = actionsValue(expression, { github });
        return [name, value === null ? '' : String(value)];
      })
    )
  );
  // Run the exact workflow Python body for every environment. Batch in one
  // interpreter to avoid hundreds of process starts, not to reimplement policy.
  const driver = `import json, os, pathlib, sys, tempfile
payload = json.load(sys.stdin)
code = compile(payload['source'], '<runner-policy workflow>', 'exec')
results = []
with tempfile.TemporaryDirectory(prefix='runner-policy-') as root:
    for i, environment in enumerate(payload['environments']):
        output = pathlib.Path(root) / str(i)
        os.environ.clear()
        os.environ.update(environment, GITHUB_OUTPUT=str(output))
        exec(code, {'__name__': '__main__'})
        results.append(output.read_text())
print(json.dumps(results))
`;
  const result = spawnSync('python3', ['-B', '-c', driver], {
    input: JSON.stringify({ source: selectionStep.run, environments }),
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 2 * 1024 * 1024,
    env: { PATH: process.env.PATH },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  selected = JSON.parse(result.stdout).map((output) => {
    assert.match(output, /^runner=(ubuntu-latest|neoos-isolated-linux)\n$/);
    const runner = output.slice(7).trim();
    const jobOutput = actionsValue(selectionJob.outputs.runner, {
      steps: { select: { outputs: { runner } } },
    });
    return actionsValue(selector.on.workflow_call.outputs.runner.value, {
      jobs: { select: { outputs: { runner: jobOutput } } },
    });
  });
  assert.equal(selected.length, cases.length);
  return selected;
}

test('hosted selector is credential-free, bounded, and reads only caller event metadata', () => {
  assert.deepEqual(Object.keys(selector.on), ['workflow_call']);
  assert.deepEqual(Object.keys(selector.on.workflow_call), ['outputs']);
  assert.deepEqual(selector.permissions, {});
  assert.deepEqual(selectionJob.permissions, {});
  assert.equal(selectionJob['runs-on'], 'ubuntu-latest');
  assert.equal(selectionJob['timeout-minutes'], 1);
  assert.equal(selectionJob.steps.length, 1);
  assert.equal(selectionStep.shell, 'python');
  assert.equal(selectionStep.uses, undefined);
  assert.equal(selectionStep.if, undefined);
  assert.equal(selectionJob.if, undefined);
  assert.equal(selectionJob['continue-on-error'], undefined);
  assert.equal(selectionStep['continue-on-error'], undefined);
  assert.equal(selectionJob.env, undefined);
  assert.equal(selector.env, undefined);
  assert.deepEqual(selectionStep.env, {
    REPOSITORY_PRIVATE: '${{ github.event.repository.private }}',
    EVENT_NAME: '${{ github.event_name }}',
    EVENT_REF: '${{ github.ref }}',
    DEFAULT_BRANCH: '${{ github.event.repository.default_branch }}',
  });
  assert.ok(!selectionStep.run.includes('${{'), 'event data must never be interpolated into code');
  selectedRunners().forEach((runner, i) =>
    assert.equal(runner, expected(cases[i]), JSON.stringify(cases[i]))
  );
});

test('runner policy discovers workflow jobs', () => {
  assert.ok(workflows.length > 0);
  for (const file of workflows) {
    const workflow = yaml.load(readFileSync(new URL(file, directory), 'utf8'));
    assert.ok(Object.keys(workflow.jobs ?? {}).length > 0, `${file}: no jobs checked`);
  }
});

for (const file of workflows) {
  const workflow = yaml.load(readFileSync(new URL(file, directory), 'utf8'));
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    const name = `${file}/${jobId}`;
    if (job.uses) {
      test(`${name}: calls the same-commit selector without inputs, secrets or permissions`, () => {
        assert.equal(jobId, 'runner');
        assert.deepEqual(job, { permissions: {}, uses: './.github/workflows/runner-policy.yml' });
      });
      continue;
    }
    test(`${name}: only private manual or exact default-branch pushes may use isolated runners`, () => {
      if (hostedOnly.has(name)) {
        assert.equal(job['runs-on'], 'ubuntu-latest');
        return;
      }
      const needs = Array.isArray(job.needs) ? job.needs : [job.needs];
      assert.ok(needs.includes('runner'), 'consumer needs the hosted selector directly');
      assert.equal(workflow.jobs.runner?.uses, './.github/workflows/runner-policy.yml');
      selectedRunners().forEach((runner, i) => {
        const context = { github: cases[i], needs: { runner: { outputs: { runner } } } };
        assert.equal(
          actionsValue(job['runs-on'], context),
          expected(cases[i]),
          `${name}: ${JSON.stringify(cases[i])}`
        );
      });
      for (const runner of ['', null]) {
        assert.equal(
          actionsValue(job['runs-on'], { needs: { runner: { outputs: { runner } } } }),
          'ubuntu-latest',
          'missing selector output must never fall back to an isolated runner'
        );
      }
    });
  }
}
