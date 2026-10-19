import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { Script, createContext } from 'node:vm';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const directory = new URL('../.github/workflows/', import.meta.url);
const workflows = readdirSync(directory).filter((file) => /\.ya?ml$/.test(file));
const hostedOnly = new Set(['randomized-inputs.yml/randomized-inputs']);

// Evaluate the actual workflow expression, not a second copy of its policy.
// This restricted subset uses only typed strings/booleans, equality, &&/||,
// parentheses and the one format call present in these workflows. Their
// evaluation agrees with Actions for these inputs. Reject new syntax rather
// than silently pretending this is a complete Actions expression evaluator.
function runnerSelector(value) {
  assert.equal(typeof value, 'string');
  assert.ok(value.startsWith('${{') && value.endsWith('}}'), 'expected runner expression');
  const expression = value.slice(3, -2).trim();
  const tokens =
    /'[^'\\]*'|github\.(?:event_name|ref|event\.repository\.(?:private|default_branch))\b|\b(?:format|true|false|null)\b|==|&&|\|\||[(),]/g;
  assert.equal(expression.replace(tokens, '').trim(), '', 'unsupported runner expression syntax');
  const script = new Script(expression);
  const context = createContext({
    format: (template, branch) => {
      assert.equal(template, 'refs/heads/{0}');
      return `refs/heads/${branch}`;
    },
  });
  return (github) => {
    context.github = github;
    return script.runInContext(context, { timeout: 100 });
  };
}

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
    test(`${name}: only private manual or default-branch pushes may use isolated runners`, () => {
      const alwaysHosted = hostedOnly.has(name);
      if (alwaysHosted) assert.equal(job['runs-on'], 'ubuntu-latest');
      const select = alwaysHosted ? () => job['runs-on'] : runnerSelector(job['runs-on']);
      for (const defaultBranch of ['main', 'trunk']) {
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
          ]) {
            for (const ref of [
              `refs/heads/${defaultBranch}`,
              'refs/heads/feature',
              'refs/tags/v1',
            ]) {
              const repository = { default_branch: defaultBranch };
              if (privacy !== undefined) repository.private = privacy;
              const github = { event_name: eventName, ref, event: { repository } };
              const eligible =
                privacy === true &&
                (eventName === 'workflow_dispatch' ||
                  (eventName === 'push' && ref === `refs/heads/${defaultBranch}`));
              assert.equal(
                select(github),
                eligible && !alwaysHosted ? 'neoos-isolated-linux' : 'ubuntu-latest',
                `${name}: privacy=${privacy} event=${eventName} ref=${ref} default=${defaultBranch}`
              );
            }
          }
        }
      }
    });
  }
}
