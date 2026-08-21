import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  findUngatedReleaseJobs,
  gateDefeatingFunctions,
  isReleaseJob,
  parseWorkflowJobs,
  runsTests,
} from './lib-workflow-graph.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowDir = path.join(repoRoot, '.github', 'workflows');

async function readWorkflows() {
  const entries = await fs.readdir(workflowDir);
  const files = entries.filter((name) => name.endsWith('.yml') || name.endsWith('.yaml')).sort();
  assert.ok(files.length > 0, 'no workflows found; the gate would pass vacuously');
  return Promise.all(
    files.map(async (name) => ({
      name,
      source: await fs.readFile(path.join(workflowDir, name), 'utf8'),
    }))
  );
}

test('every workflow in this repo parses into a job graph', async () => {
  for (const { name, source } of await readWorkflows()) {
    const jobs = parseWorkflowJobs(source);
    assert.ok(jobs.length > 0, `${name} produced no jobs`);
    for (const job of jobs) {
      for (const dependency of job.needs) {
        assert.ok(
          jobs.some((candidate) => candidate.name === dependency),
          `${name}: job "${job.name}" needs "${dependency}", which is not a job in that workflow`
        );
      }
    }
  }
});

test('no job that writes to a release target runs before its tests', async () => {
  for (const { name, source } of await readWorkflows()) {
    const failures = findUngatedReleaseJobs(source);
    assert.deepEqual(
      failures,
      [],
      `${name} has ungated release jobs:\n${failures
        .map((failure) => `  - ${failure.job}: ${failure.reason}`)
        .join('\n')}`
    );
  }
});

test('the Vercel production deploy is gated on a test job', async () => {
  // Pinned deliberately: the sweep above passes vacuously if the deploy job is
  // ever renamed or its release step reworded past the marker list.
  const source = await fs.readFile(path.join(workflowDir, 'deploy-web.yml'), 'utf8');
  const jobs = parseWorkflowJobs(source);
  const deploy = jobs.find((job) => job.name === 'deploy');
  assert.ok(deploy, 'deploy-web.yml no longer defines a `deploy` job');
  assert.ok(isReleaseJob(deploy), 'the deploy job no longer looks like a release job');

  const gates = jobs.filter((job) => deploy.needs.includes(job.name) && runsTests(job));
  assert.ok(
    gates.length > 0,
    `deploy needs [${deploy.needs.join(', ')}], none of which runs tests`
  );

  // The secrets preflight is a skip switch, not a quality gate. Losing it would
  // not be a regression in gating, but losing the distinction would be.
  assert.ok(
    deploy.needs.includes('preflight'),
    'deploy no longer needs preflight; the secret check has been dropped'
  );
  const preflight = jobs.find((job) => job.name === 'preflight');
  assert.ok(
    preflight && !runsTests(preflight),
    'preflight is not a test job and must not pose as one'
  );

  // This job is the one place in either repo where a release job carries an
  // `if:` at all, so it is the one place the implicit success() can be lost.
  // A plain comparison keeps it; naming a status function would not.
  assert.deepEqual(
    gateDefeatingFunctions(deploy.condition),
    [],
    `deploy's if: (${deploy.condition}) drops the success() check that makes needs: a gate`
  );
});

test('the ghcr image publish is gated on the worker suites it ships', async () => {
  const source = await fs.readFile(path.join(workflowDir, 'publish-images.yml'), 'utf8');
  const jobs = parseWorkflowJobs(source);
  const publish = jobs.find((job) => job.name === 'build-and-push');
  assert.ok(publish, 'publish-images.yml no longer defines a `build-and-push` job');
  assert.ok(isReleaseJob(publish), 'the build-and-push job no longer looks like a release job');

  const gate = jobs.find((job) => publish.needs.includes(job.name) && runsTests(job));
  assert.ok(gate, `build-and-push needs [${publish.needs.join(', ')}], none of which runs tests`);

  // The images are built from these two workers; a gate that does not exercise
  // them would be a gate in name only.
  for (const workspace of ['workers/nitro-worker', 'workers/morpheus-relayer']) {
    assert.ok(
      gate.body.includes(`npm --prefix ${workspace} test`),
      `the publish-images gate does not run the ${workspace} suite`
    );
  }

  // `packages: write` is what makes this job able to overwrite :latest. The
  // gate job must not carry it.
  assert.ok(!gate.body.includes('packages: write'), 'the test gate holds packages: write');
  assert.ok(publish.body.includes('packages: write'), 'build-and-push lost its packages: write');
});

test('a single job that tests before it publishes counts as gated', () => {
  // The shape neo-os-devpack/publish.yml ships: one job, `npm test` ahead of
  // the publish step. A failed step ends the job, so publish never runs.
  // Demanding needs: here would flag the in-house reference as broken.
  const inline = [
    'jobs:',
    '  publish:',
    '    steps:',
    '      - run: npm ci --no-audit --no-fund',
    '      - run: npm test',
    '      - name: Publish missing package versions',
    '        run: npm publish --workspace framework',
  ].join('\n');
  assert.deepEqual(findUngatedReleaseJobs(inline), []);

  // Ordering is the whole point: publishing first and testing afterwards is not
  // a gate, however similar the job looks.
  const backwards = [
    'jobs:',
    '  publish:',
    '    steps:',
    '      - run: npm publish --workspace framework',
    '      - run: npm test',
  ].join('\n');
  assert.deepEqual(findUngatedReleaseJobs(backwards), [
    { job: 'publish', reason: 'declares no needs:, so nothing gates it' },
  ]);

  // A test step allowed to fail gates nothing.
  const softFail = [
    'jobs:',
    '  publish:',
    '    steps:',
    '      - run: npm test',
    '        continue-on-error: true',
    '      - run: npm publish --workspace framework',
  ].join('\n');
  assert.deepEqual(findUngatedReleaseJobs(softFail), [
    { job: 'publish', reason: 'declares no needs:, so nothing gates it' },
  ]);
});

test('no release job carries an if: that would let it run past a failed gate', async () => {
  // `needs:` only means "and they passed" because GitHub applies a default
  // success() check. Writing always()/failure()/cancelled() into a release
  // job's if: removes it, and the workflow still reads as gated.
  for (const { name, source } of await readWorkflows()) {
    for (const job of parseWorkflowJobs(source)) {
      if (!isReleaseJob(job)) continue;
      assert.deepEqual(
        gateDefeatingFunctions(job.condition),
        [],
        `${name}: release job "${job.name}" has if: ${job.condition}`
      );
    }
  }
});

test('an if: status function is reported as ungating even when needs: looks right', () => {
  const alwaysRuns = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - run: npm test',
    '  deploy:',
    '    needs: [test]',
    "    if: ${{ always() && github.ref == 'refs/heads/main' }}",
    '    steps:',
    '      - run: vercel deploy --prebuilt --prod',
  ].join('\n');
  assert.deepEqual(findUngatedReleaseJobs(alwaysRuns), [
    {
      job: 'deploy',
      reason: 'its if: calls always(), which drops the implicit success() over needs:',
    },
  ]);

  // `!cancelled()` is the same hole written the other way round.
  const notCancelled = alwaysRuns.replace(
    "always() && github.ref == 'refs/heads/main'",
    '!cancelled()'
  );
  assert.deepEqual(findUngatedReleaseJobs(notCancelled), [
    {
      job: 'deploy',
      reason: 'its if: calls cancelled(), which drops the implicit success() over needs:',
    },
  ]);

  // The shape deploy-web.yml actually ships: an ordinary comparison, which
  // keeps the implicit success() and stays a real gate.
  const preflightGuard = alwaysRuns.replace(
    "${{ always() && github.ref == 'refs/heads/main' }}",
    "${{ needs.preflight.outputs.ready == 'true' }}"
  );
  assert.deepEqual(findUngatedReleaseJobs(preflightGuard), []);
});

test("a job's if: is read in scalar and block form, and a step's if: is not mistaken for it", () => {
  const scalar = parseWorkflowJobs(
    ['jobs:', '  a:', '    if: ${{ always() }}', '    steps:', '      - run: echo hi'].join('\n')
  );
  assert.deepEqual(gateDefeatingFunctions(scalar[0].condition), ['always()']);

  const block = parseWorkflowJobs(
    ['jobs:', '  a:', '    if: >-', '      ${{ failure() ||', '      cancelled() }}', '  b:'].join(
      '\n'
    )
  );
  assert.deepEqual(gateDefeatingFunctions(block[0].condition), ['failure()', 'cancelled()']);

  const stepOnly = parseWorkflowJobs(
    ['jobs:', '  a:', '    steps:', '      - if: ${{ always() }}', '        run: echo hi'].join(
      '\n'
    )
  );
  assert.equal(stepOnly[0].condition, '');

  const none = parseWorkflowJobs(
    ['jobs:', '  a:', '    steps:', '      - run: echo hi'].join('\n')
  );
  assert.deepEqual(gateDefeatingFunctions(none[0].condition), []);
});

test('the parser reads all three needs: spellings and rejects what it cannot read', () => {
  const flow = parseWorkflowJobs(
    ['jobs:', '  a:', "    needs: [x, 'y']", '  x:', '  y:'].join('\n')
  );
  assert.deepEqual(flow[0].needs, ['x', 'y']);

  const scalar = parseWorkflowJobs(['jobs:', '  a:', '    needs: x', '  x:'].join('\n'));
  assert.deepEqual(scalar[0].needs, ['x']);

  const block = parseWorkflowJobs(
    ['jobs:', '  a:', '    needs:', '      - x', '      - y', '  x:', '  y:'].join('\n')
  );
  assert.deepEqual(block[0].needs, ['x', 'y']);

  // A `needs` key inside a step must not be mistaken for the job's own.
  const nested = parseWorkflowJobs(
    ['jobs:', '  a:', '    steps:', '      - with:', '          needs: x'].join('\n')
  );
  assert.deepEqual(nested[0].needs, []);

  assert.throws(() => parseWorkflowJobs('name: x\non:\n  push:\n'), /no top-level `jobs:`/);
  assert.throws(() => parseWorkflowJobs('jobs:\n'), /no jobs/);
});

test('the gate reports the exact shapes this repo shipped before the fix', () => {
  // deploy-web.yml as it stood: gated only on a secrets preflight.
  const preflightOnly = [
    'jobs:',
    '  preflight:',
    '    steps:',
    '      - run: echo ready=true',
    '  deploy:',
    '    needs: preflight',
    '    steps:',
    '      - run: vercel deploy --prebuilt --prod',
  ].join('\n');
  assert.deepEqual(findUngatedReleaseJobs(preflightOnly), [
    { job: 'deploy', reason: 'none of its transitive needs (preflight) runs tests' },
  ]);

  // publish-images.yml as it stood: a single job, no needs: at all.
  const ungated = [
    'jobs:',
    '  build-and-push:',
    '    steps:',
    '      - uses: docker/build-push-action@v6',
    '        with:',
    '          push: true',
  ].join('\n');
  assert.deepEqual(findUngatedReleaseJobs(ungated), [
    { job: 'build-and-push', reason: 'declares no needs:, so nothing gates it' },
  ]);
});
