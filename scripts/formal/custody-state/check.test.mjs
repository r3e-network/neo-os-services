import assert from 'node:assert/strict';
import test from 'node:test';
import { buildModel, buildQueries } from './model.mjs';
import { parseSolverOutput, SAFETY_IDS, COVER_IDS } from './check.mjs';
import { finiteEncoding } from './smt-lib.mjs';

test('obligation and reachability identities are explicit and complete', () => {
  const model = buildModel({ bound: 2 });
  assert.deepEqual(Object.keys(model.properties), SAFETY_IDS);
  assert.deepEqual(Object.keys(model.covers), COVER_IDS);
  assert.throws(() => buildModel({ bound: 0 }), /bound/);
  assert.throws(() => buildModel({ mutation: 'typo' }), /mutation/);
  assert.throws(() => buildQueries(model, []), /identities/);
  assert.throws(() => buildQueries(model, [{ id: 'x' }, { id: 'x' }]), /identities/);
});

test('parser requires ordered identities and actual concrete SAT witnesses', () => {
  const checks = [
    { id: 'safe', expected: 'unsat' },
    { id: 'negative-control', expected: 'sat' },
  ];
  const parsed = parseSolverOutput(
    'CHECK:safe\nunsat\nCHECK:negative-control\nsat\n((owner_0 (- 1)) (lease_0 false))\n',
    checks
  );
  assert.deepEqual(parsed[1].values, { owner_0: -1, lease_0: false });
  assert.ok(parsed.every((item) => item.passed));
  assert.throws(() => parseSolverOutput('CHECK:negative-control\nsat\n', checks), /identity/);
  assert.throws(
    () => parseSolverOutput('CHECK:safe\nunsat\nCHECK:negative-control\nsat\n', checks),
    /witness/
  );
  assert.throws(
    () => parseSolverOutput('CHECK:safe\nunsat\n(error "ignored")\n', checks.slice(0, 1)),
    /unexpected/
  );
  assert.throws(
    () =>
      parseSolverOutput('CHECK:safe\nunsat\nCHECK:negative-control\nsat\n((a 0) (a 1))', checks),
    /duplicate/
  );
});

test('unknown and wrong solver answers cannot pass', () => {
  const check = [{ id: 'safe', expected: 'unsat' }];
  assert.equal(parseSolverOutput('CHECK:safe\nunknown', check)[0].passed, false);
  assert.equal(parseSolverOutput('CHECK:safe\nsat', check)[0].passed, false);
  assert.throws(() => parseSolverOutput('CHECK:safe\nunsat\nunsat', check), /unexpected/);
  assert.throws(() => parseSolverOutput('CHECK:safe\n(error "bad input")', check), /answer/);
  assert.throws(() => parseSolverOutput('CHECK:safe\nunsat\n(', check), /truncated/);
});

test('finite encoding preserves comparisons, constants and solver settings', () => {
  const output = finiteEncoding(
    '(set-option :timeout 30000)\n(declare-const a Int)\n(assert (and (= a (+ 1 2)) (< a 40)))'
  );
  assert.match(output, /:timeout 30000/);
  assert.match(output, /a \(_ BitVec 8\)/);
  assert.match(output, /bvadd \(_ bv1 8\) \(_ bv2 8\)/);
  assert.match(output, /bvult a \(_ bv40 8\)/);
  assert.throws(() => finiteEncoding('(assert (= a 256))'), /overflows/);
  const values = parseSolverOutput('CHECK:trace\nsat\n((a #x0e) (b #b00000011))', [
    { id: 'trace', expected: 'sat' },
  ]);
  assert.deepEqual(values[0].values, { a: 14, b: 3 });
});
