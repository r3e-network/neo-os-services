// Guards the move of the top-level Supabase directory to db/services/ (7f430ab).
//
// That move left three consumers reading the old location: the real-PostgreSQL
// delivery acceptance script (scripts/test-relayer-delivery-v2.sh), the relayer
// schema test and the automation-claim test. Each failed with ENOENT, and in CI
// the acceptance script's failure also skipped the Cargo.lock drift guard and
// the NeoNexus signer contract that follow it in the rust job. The CI path filter
// never listed the migrations or the SQL acceptance tests either, so a pull
// request that only touched them skipped the jobs that exercise them.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { parseWorkflowJobs } from './lib-workflow-graph.mjs';

const root = path.resolve(import.meta.dirname, '..');
const MIGRATIONS_DIR = 'db/services/migrations';

// Every DeliveryJob schema change the acceptance script must apply. neo-os-web's
// protocol registry names these two files as the DeliveryJob authority.
const DELIVERY_MIGRATIONS = [
  '20260908040427_relayer_delivery_v2.sql',
  '20260920102300_relayer_delivery_completion_identity.sql',
];

test('no tracked file points at the retired top-level migration directory', () => {
  // Historical plans describe the layout as it was when they were written.
  let output = '';
  try {
    output = execFileSync(
      'git',
      [
        'grep',
        '-n',
        '-I',
        '-E',
        'supabase/(migrations|seed[.]sql)',
        '--',
        '.',
        ':(exclude)docs/plans/**',
      ],
      { cwd: root, encoding: 'utf8' }
    );
  } catch (error) {
    // git grep exits 1 when nothing matches; anything else is a real failure.
    if (error.status !== 1) throw error;
  }
  assert.equal(
    output,
    '',
    `these files still name the pre-7f430ab path; use ${MIGRATIONS_DIR}:\n${output}`
  );
});

test('the delivery acceptance script applies every DeliveryJob migration', () => {
  const script = fs.readFileSync(path.join(root, 'scripts/test-relayer-delivery-v2.sh'), 'utf8');
  const glob = script.match(/"\$repo"\/([\w./-]+)\/\*_relayer_delivery_\*\.sql/);
  assert.ok(glob, 'scripts/test-relayer-delivery-v2.sh no longer names its migration glob');
  assert.equal(glob[1], MIGRATIONS_DIR);

  const applied = fs
    .readdirSync(path.join(root, glob[1]))
    .filter((name) => /_relayer_delivery_.*\.sql$/.test(name))
    .sort();
  for (const migration of DELIVERY_MIGRATIONS) {
    assert.ok(applied.includes(migration), `${glob[1]}/${migration} is not applied by the script`);
  }
});

test('the SQL fixtures the Node tests read exist under db/services/migrations', () => {
  for (const [consumer, migration] of [
    ['workers/morpheus-relayer/src/relayer-schema.test.mjs', '0016_allow_neox_relayer_jobs.sql'],
    ['scripts/example-contract-artifacts.test.mjs', '0013_automation_processing_claims.sql'],
  ]) {
    const source = fs.readFileSync(path.join(root, consumer), 'utf8');
    assert.ok(
      source.includes(`'${MIGRATIONS_DIR}/${migration}'`),
      `${consumer} must read ${MIGRATIONS_DIR}/${migration}`
    );
    assert.ok(fs.existsSync(path.join(root, MIGRATIONS_DIR, migration)), `${migration} is missing`);
  }
});

test('the CI code filter selects migration and SQL acceptance changes', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  const changes = parseWorkflowJobs(workflow).find((job) => job.name === 'changes');
  assert.ok(changes, 'ci.yml no longer defines the changes job');
  const code = changes.body.match(/^ {12}code:\n((?: {14}(?:- |#).*\n?)+)/m);
  assert.ok(code, 'ci.yml changes job no longer defines a code filter');
  const patterns = [...code[1].matchAll(/- '([^']+)'/g)].map((match) => match[1]);
  // The rust job applies db/services/migrations with tests/*.sql, and the
  // morpheus-relayer suite reads db/services/migrations directly.
  for (const pattern of ['db/**', 'tests/**']) {
    assert.ok(patterns.includes(pattern), `code filter must include '${pattern}'`);
  }
});
