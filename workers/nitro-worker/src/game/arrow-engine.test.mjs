// Deterministic Curve Arrow engine coverage:
//  - deal determinism + frontend-parseable clue shape,
//  - solvable-layout property: every dealt level is clearable with a SINGLE
//    press/release pair (guards the generator against unsolvable walls),
//  - flight golden vectors (straight bullseye, guaranteed miss),
//  - wrapper op validation, replay==live agreement, ScoreRejection below
//    target, and the registry/manifest pin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import {
  ARROW_BUDGETS,
  BOW,
  FIELD_H,
  FIELD_W,
  LEVEL_TARGETS,
  MAX_HOLD_PAIRS,
  TICKS_MAX,
  applyShot,
  arrowAnswer,
  arrowCluesView,
  createRun,
  dealArrow,
  isHeld,
  normalizeHolds,
  replayArrow,
  simulateShot,
} from './engines/arrow.adapter.js';
import * as wrapper from './wrappers/arrow.wrapper.js';
import { ScoreRejection } from './abi.js';
import { ENGINE_MANIFEST, engineHashOfFile, resolveEngine } from './registry.js';

function secretOf(label) {
  return createHmac('sha256', Buffer.alloc(32, 7)).update(label, 'utf8').digest();
}

// Brute-force a level over single press/release pairs (plus the straight
// shot) — the search space the solvable-layout property is defined over.
function solveLevel(level) {
  if (simulateShot(level, []).hit) return [];
  for (let press = 0; press <= 60; press += 2) {
    for (let len = 2; len <= 80; len += 2) {
      const holds = [press, press + len];
      if (simulateShot(level, holds).hit) return holds;
    }
  }
  return null;
}

// Holding through the whole flight loops the arrow off the left field edge —
// a guaranteed miss that spends an arrow.
const MISS_HOLDS = [0, TICKS_MAX - 1];

// ─── Deal ────────────────────────────────────────────────────────────────────

test('arrow: deal is a stable pure function with in-band, separated walls', () => {
  const secret = secretOf('arrow-golden');
  for (const difficulty of [0, 1, 2]) {
    const a = dealArrow(secret, difficulty);
    const b = dealArrow(secret, difficulty);
    assert.deepEqual(a, b, 'deal not deterministic');
    assert.equal(a.levels.length, LEVEL_TARGETS[difficulty]);

    a.levels.forEach((level, i) => {
      const { target, obstacles } = level;
      assert.ok(target.x >= 1180 && target.x <= 1519, `target.x ${target.x}`);
      assert.ok(target.y >= 160 && target.y <= 499, `target.y ${target.y}`);
      assert.ok(obstacles.length <= Math.min(1 + (i >> 1), 4), 'too many walls');
      for (const rect of obstacles) {
        assert.equal(rect.w, 36);
        assert.ok(rect.h >= 240 && rect.h <= 539, `wall h ${rect.h}`);
        assert.ok(rect.x >= 420 && rect.x + rect.w <= FIELD_W, `wall x ${rect.x}`);
        assert.ok(rect.y >= 0 && rect.y + rect.h <= FIELD_H, `wall y ${rect.y}`);
        // Every wall clears the target's flight band by the deal margin.
        assert.ok(
          rect.y >= target.y + 90 || rect.y + rect.h <= target.y - 90,
          `wall ${JSON.stringify(rect)} intrudes on the target band y=${target.y}`
        );
      }
      // Accepted walls are horizontally separated.
      for (let m = 0; m < obstacles.length; m += 1) {
        for (let n = m + 1; n < obstacles.length; n += 1) {
          assert.ok(Math.abs(obstacles[m].x - obstacles[n].x) >= 90, 'walls too close');
        }
      }
    });
  }
});

test('arrow: clues view is the exact JSON shape the frontend parseInitialState consumes', () => {
  const secret = secretOf('arrow-golden');
  for (const difficulty of [0, 1, 2]) {
    const clues = arrowCluesView(secret, difficulty);
    assert.equal(clues, arrowCluesView(secret, difficulty), 'clues view not stable');
    const parsed = JSON.parse(clues);
    assert.deepEqual(parsed, dealArrow(secret, difficulty));
    assert.ok(parsed.levels.length >= 1 && parsed.levels.length <= 7);
    for (const level of parsed.levels) {
      assert.ok(Number.isInteger(level.target.x) && Number.isInteger(level.target.y));
      assert.ok(Array.isArray(level.obstacles));
      for (const rect of level.obstacles) {
        for (const key of ['x', 'y', 'w', 'h']) assert.ok(Number.isInteger(rect[key]));
        assert.ok(rect.w > 0 && rect.h > 0);
      }
    }
  }
});

test('arrow: every dealt level is clearable with a single press/release pair', () => {
  // The solvable-layout property that guards the wall generator: for several
  // secrets and every difficulty, a single-pair hold search clears each level.
  for (let s = 0; s < 8; s += 1) {
    const secret = secretOf(`arrow-solve-${s}`);
    for (const difficulty of [0, 1, 2]) {
      const { levels } = dealArrow(secret, difficulty);
      levels.forEach((level, i) => {
        assert.ok(
          solveLevel(level) !== null,
          `seed ${s} difficulty ${difficulty} level ${i} unsolvable: ${JSON.stringify(level)}`
        );
      });
    }
  }
});

// ─── Flight ──────────────────────────────────────────────────────────────────

test('arrow: an unobstructed straight shot lands a bullseye at bow height', () => {
  const level = { target: { x: 1200, y: BOW.y }, obstacles: [] };
  const outcome = simulateShot(level, []);
  assert.equal(outcome.hit, true);
  assert.equal(outcome.ring, 0);
  // A target far above the level flight line is missed by the straight shot.
  const high = simulateShot({ target: { x: 1200, y: 200 }, obstacles: [] }, []);
  assert.equal(high.hit, false);
  assert.equal(high.ring, -1);
});

test('arrow: holds are validated as ascending press/release pairs', () => {
  assert.deepEqual(normalizeHolds([]), []);
  assert.deepEqual(normalizeHolds([0, 10, 20, 30]), [0, 10, 20, 30]);
  assert.equal(normalizeHolds([0, 10, 5]), null); // odd length
  assert.equal(normalizeHolds([10, 10]), null); // not strictly ascending
  assert.equal(normalizeHolds([20, 10]), null); // descending
  assert.equal(normalizeHolds([-1, 10]), null); // below range
  assert.equal(normalizeHolds([0, TICKS_MAX]), null); // above range
  assert.equal(normalizeHolds([0.5, 10]), null); // non-integer
  const tooMany = Array.from({ length: (MAX_HOLD_PAIRS + 1) * 2 }, (_, i) => i);
  assert.equal(normalizeHolds(tooMany), null);
  assert.equal(isHeld([4, 8], 4), true); // press-inclusive
  assert.equal(isHeld([4, 8], 7), true);
  assert.equal(isHeld([4, 8], 8), false); // release-exclusive
});

test('arrow: run accounting spends the budget on misses and wins on clears', () => {
  const secret = secretOf('arrow-run');
  const { levels } = dealArrow(secret, 0);
  let run = createRun(levels, 0);
  assert.equal(run.budget, ARROW_BUDGETS[0]);

  // A full-flight hold loops off the left edge — a spent arrow, no clear.
  const missed = applyShot(run, levels, MISS_HOLDS);
  assert.equal(missed.outcome.hit, false);
  assert.equal(missed.run.arrowsUsed, 1);
  assert.equal(missed.run.cleared, 0);

  // Clearing every level wins the run before the budget is spent.
  run = createRun(levels, 0);
  for (const level of levels) {
    const holds = solveLevel(level);
    assert.ok(holds !== null);
    const next = applyShot(run, levels, holds);
    assert.equal(next.outcome.hit, true);
    run = next.run;
  }
  assert.equal(run.won, true);
  assert.equal(run.done, true);
  assert.equal(run.cleared, levels.length);

  // Spending the whole budget on misses ends the run without a win.
  run = createRun(levels, 0);
  for (let i = 0; i < ARROW_BUDGETS[0]; i += 1) {
    run = applyShot(run, levels, MISS_HOLDS).run;
  }
  assert.equal(run.done, true);
  assert.equal(run.won, false);
  assert.equal(run.arrowsUsed, ARROW_BUDGETS[0]);
});

test('arrow: replay is deterministic and mirrors the live shot sequence', () => {
  const secret = secretOf('arrow-replay');
  const { levels } = dealArrow(secret, 1);
  const shots = [MISS_HOLDS];
  for (const level of levels) shots.push(solveLevel(level));
  const a = replayArrow(secret, 1, shots);
  const b = replayArrow(secret, 1, shots);
  assert.deepEqual(a, b);
  assert.equal(a.won, true);
  assert.equal(a.cleared, levels.length);
  assert.equal(a.arrowsUsed, shots.length);
  assert.equal(a.applied, shots.length);
});

// ─── Wrapper ─────────────────────────────────────────────────────────────────

test('arrow wrapper: applyOp validates the op and rejects shots after the run ends', () => {
  const secret = secretOf('arrow-wrapper');
  const { state } = wrapper.deal(secret, 0);

  const badType = wrapper.applyOp(state, { type: 'flap' });
  assert.ok(badType.reject);
  assert.equal(badType.reject.status, 400);

  const badHolds = wrapper.applyOp(state, { type: 'shot', holds: [10, 5] });
  assert.ok(badHolds.reject);
  assert.equal(badHolds.reject.status, 400);

  const undo = wrapper.applyUndo(state);
  assert.ok(undo.reject, 'undo must always be rejected (maxUndos is 0)');

  // Spend the whole budget on misses; the next shot is rejected as over.
  for (let i = 0; i < ARROW_BUDGETS[0]; i += 1) {
    const outcome = wrapper.applyOp(state, { type: 'shot', holds: MISS_HOLDS });
    assert.ok(!outcome.reject, 'in-budget shot must be accepted');
    assert.equal(outcome.view.ok, true);
    assert.equal(outcome.view.hit, false);
  }
  assert.equal(state.run.done, true);
  const over = wrapper.applyOp(state, { type: 'shot', holds: [] });
  assert.ok(over.reject);
  assert.equal(over.reject.status, 409);
});

test('arrow wrapper: replay reproduces the live run and score binds the canonical answer', () => {
  const secret = secretOf('arrow-live');
  const { state: live } = wrapper.deal(secret, 0);
  const opLog = [{ type: 'shot', holds: MISS_HOLDS }];
  for (const level of live.levels) opLog.push({ type: 'shot', holds: solveLevel(level) });
  for (const op of opLog) {
    const outcome = wrapper.applyOp(live, op);
    assert.ok(!outcome.reject, outcome.reject?.message);
  }
  assert.equal(live.run.won, true);

  const rebuilt = wrapper.replay(secret, opLog, 0);
  assert.deepEqual(rebuilt.run, live.run);

  const sLive = wrapper.score(live, 0, {});
  const sRebuilt = wrapper.score(rebuilt, 0, {});
  assert.equal(sRebuilt.score, sLive.score);
  assert.equal(sRebuilt.answerHash.toString('hex'), sLive.answerHash.toString('hex'));
  assert.equal(sLive.score, LEVEL_TARGETS[0]);
  assert.deepEqual(sLive.scoreField, {
    cleared: live.run.cleared,
    arrowsUsed: live.run.arrowsUsed,
  });
  const expected = createHash('sha256')
    .update(arrowAnswer(live.run.cleared, live.run.arrowsUsed), 'utf8')
    .digest('hex');
  assert.equal(sLive.answerHash.toString('hex'), expected);

  // A replay log containing an op the live session would reject throws.
  assert.throws(
    () => wrapper.replay(secret, [{ type: 'shot', holds: [3, 1] }], 0),
    /invalid replay op/
  );
});

test('arrow wrapper: score rejects a below-target run with a ScoreRejection', () => {
  const secret = secretOf('arrow-reject');
  const { state } = wrapper.deal(secret, 0);
  assert.throws(() => wrapper.score(state, 0, {}), ScoreRejection);
  // A busted run (budget spent, nothing cleared) is rejected too.
  for (let i = 0; i < ARROW_BUDGETS[0]; i += 1) {
    wrapper.applyOp(state, { type: 'shot', holds: MISS_HOLDS });
  }
  assert.throws(() => wrapper.score(state, 0, {}), ScoreRejection);
  // ...but a targetOverride of 0 (test/operator tuning) accepts it.
  const overridden = wrapper.score(state, 0, { targetOverride: 0 });
  assert.equal(overridden.score, 0);
});

// ─── Registry ────────────────────────────────────────────────────────────────

test('arrow: registry loads the engine and the manifest pins its wrapper hash', () => {
  const engine = resolveEngine('miniapp-curve-arrow');
  assert.equal(engine.appId, 'miniapp-curve-arrow');
  for (const fn of ['deal', 'applyOp', 'applyUndo', 'replay', 'score']) {
    assert.equal(typeof engine[fn], 'function');
  }
  assert.equal(engine.descriptor.maxUndos, 0);
  assert.equal(engine.descriptor.revealPolicy, 'clues');
  const liveHash = engineHashOfFile('arrow.wrapper.js');
  assert.equal(engine.engineHash, liveHash);
  assert.equal(ENGINE_MANIFEST['miniapp-curve-arrow'], liveHash, 'manifest hash out of date');
});
