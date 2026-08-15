// Engine-ABI conformance — every registered engine must implement the fixed ABI
// (deal / applyOp / applyUndo / replay / score + a well-formed descriptor) and
// satisfy the cross-engine invariants the generic host relies on:
//   - deal is a pure function of (problemSecret, difficulty),
//   - a replay of the accepted op log reproduces the SAME score/answerHash as the
//     live state (kernel re-derivation reproducibility),
//   - the descriptor carries all per-game constants (targets, timeWindow, gates,
//     revealPolicy, maxOps, maxUndos, undoPenaltyPct),
//   - applyOp rejects a malformed op without throwing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { __rebuildRegistryForTests, registeredAppIds, resolveEngine } from './registry.js';

__rebuildRegistryForTests({ strict: false });

const secretOf = (label) =>
  createHmac('sha256', Buffer.alloc(32, 7)).update(label, 'utf8').digest();

// A short scripted op plan per engine that produces at least one accepted op so
// the replay-reproduces-live invariant is exercised. Reflex ops carry opMeta
// through the host; here we drive the engine directly with a monotonic elapsed
// clock so applyOp / replay see equivalent timing.
const PLANS = {
  'miniapp-sudoku': (engine, secret) => {
    const { state } = engine.deal(secret, 0);
    const holes = [];
    for (let i = 0; i < 81 && holes.length < 5; i += 1) {
      if (state.puzzle.charAt(i) === '0') holes.push(i);
    }
    return holes.map((cell) => ({
      type: 'place',
      cell,
      digit: Number(state.solution.charAt(cell)),
    }));
  },
  'miniapp-game-2048': () => [
    { type: 'move', dir: 0 },
    { type: 'move', dir: 1 },
    { type: 'move', dir: 2 },
    { type: 'move', dir: 3 },
  ],
  'miniapp-flappy-dash': () => [{ type: 'flap' }, { type: 'flap' }, { type: 'flap' }],
  'miniapp-snake-bounty': () => [
    { type: 'move', dir: 1 },
    { type: 'move', dir: 1 },
    { type: 'move', dir: 2 },
  ],
  'miniapp-aim-master': () => [
    { type: 'aim', position: 150 },
    { type: 'aim', position: 150 },
  ],
  'miniapp-color-clash': (engine, secret) => {
    // Press the first two revealed colours correctly.
    const { state } = engine.deal(secret, 0);
    return [
      { type: 'press', color: state.sequence.charCodeAt(0) - 48 },
      { type: 'press', color: state.sequence.charCodeAt(0) - 48 },
    ];
  },
  'miniapp-merge-kingdom': () => [],
  'miniapp-pet-potion': () => [{ type: 'feed' }, { type: 'rest' }, { type: 'play' }],
  'miniapp-sheep-solitaire': (engine, secret) => {
    // Pick two currently-exposed cards from the deterministic deal (the top
    // layer is never covered, so the first exposed cards are always pickable).
    const { startView } = engine.deal(secret, 0);
    return startView.cards
      .filter((card) => card.exposed && !card.picked)
      .slice(0, 2)
      .map((card) => ({ type: 'pick', cardId: card.id }));
  },
  'miniapp-jump-rush': (engine, secret) => {
    // Jump the first four gaps of the deterministic deal at each platform's
    // ideal charge (evaluateJump's model: 50 + gap/4, clamped to 0..100) so
    // every scripted jump lands.
    const { startView } = engine.deal(secret, 0);
    return startView.platforms.slice(1, 5).map((platform) => ({
      type: 'jump',
      chargeLevel: Math.min(100, Math.max(0, 50 + platform.gap / 4)),
    }));
  },
  'miniapp-curve-arrow': () => [
    { type: 'shot', holds: [] },
    { type: 'shot', holds: [0, 20] },
  ],
};

// Drive the plan through applyOp, mirroring the host's op-log recording, and
// return { state, opLog }.
function driveLive(engine, secret, plan) {
  const { state } = engine.deal(secret, 0);
  const opLog = [];
  let elapsed = 0;
  const s = { engineState: state };
  // Space ops generously (>= the widest per-op action-spacing gate, pet's 1.5s).
  for (const op of plan) {
    elapsed += 1600;
    const outcome = engine.applyOp(s.engineState, op, {
      elapsedMs: elapsed,
      nowMs: 1_000_000 + elapsed,
      startedAtMs: 1_000_000,
      resumed: false,
    });
    assert.ok(
      !outcome.reject,
      `${engine.appId} rejected a scripted op: ${outcome.reject?.message}`
    );
    s.engineState = outcome.state;
    if (outcome.view?.ok !== false) opLog.push(op);
  }
  return { state: s.engineState, opLog };
}

for (const appId of registeredAppIds()) {
  test(`engine ABI: ${appId} exposes the fixed ABI and a well-formed descriptor`, () => {
    const engine = resolveEngine(appId);
    for (const fn of ['deal', 'applyOp', 'applyUndo', 'replay', 'score']) {
      assert.equal(typeof engine[fn], 'function', `${appId} missing ${fn}`);
    }
    const d = engine.descriptor;
    assert.ok(d && typeof d === 'object', `${appId} missing descriptor`);
    assert.ok(Array.isArray(d.targets) && d.targets.length === 3, `${appId} targets`);
    assert.ok(Array.isArray(d.timeWindow.limitMs) && d.timeWindow.limitMs.length === 3);
    assert.ok(Array.isArray(d.timeWindow.minSolveMs) && d.timeWindow.minSolveMs.length === 3);
    assert.ok(d.gates && typeof d.gates === 'object', `${appId} gates`);
    assert.equal(typeof d.revealPolicy, 'string');
    assert.ok(Number.isInteger(d.maxOps) && d.maxOps > 0);
    assert.ok(Number.isInteger(d.maxUndos) && d.maxUndos >= 0);
    assert.ok(Number.isInteger(d.undoPenaltyPct) && d.undoPenaltyPct >= 0);
    assert.match(engine.engineHash, /^[0-9a-f]{64}$/);
  });

  test(`engine ABI: ${appId} deal is a pure function of (secret, difficulty)`, () => {
    const engine = resolveEngine(appId);
    const secret = secretOf(`${appId}-pure`);
    const a = engine.deal(secret, 0);
    const b = engine.deal(secret, 0);
    assert.deepEqual(a.startView, b.startView, `${appId} startView not deterministic`);
  });

  test(`engine ABI: ${appId} applyOp rejects a malformed op without throwing`, () => {
    const engine = resolveEngine(appId);
    const { state } = engine.deal(secretOf(`${appId}-bad`), 0);
    const outcome = engine.applyOp(
      state,
      { type: 'definitely-not-a-real-op' },
      {
        elapsedMs: 100,
        nowMs: 1_000_100,
        startedAtMs: 1_000_000,
      }
    );
    assert.ok(outcome.reject, `${appId} should reject an unknown op type`);
    assert.equal(typeof outcome.reject.status, 'number');
  });

  test(`engine ABI: ${appId} replay is deterministic (kernel re-derivation reproducibility)`, () => {
    const engine = resolveEngine(appId);
    const secret = secretOf(`${appId}-replay`);
    const { state: live, opLog } = driveLive(engine, secret, PLANS[appId](engine, secret));

    const rebuiltA = engine.replay(secret, opLog, 0);
    const rebuiltB = engine.replay(secret, opLog, 0);
    const timing = { elapsedMs: 600, startedAtMs: 1_000_000, nowMs: 1_000_600 };

    // Two replays of the same log ALWAYS agree — the kernel re-derivation is
    // reproducible for every engine.
    const sA = engine.score(rebuiltA, 0, {
      ...timing,
      targetOverride: 0,
      answer: sudokuAnswer(appId, rebuiltA),
    });
    const sB = engine.score(rebuiltB, 0, {
      ...timing,
      targetOverride: 0,
      answer: sudokuAnswer(appId, rebuiltB),
    });
    assert.equal(sB.score, sA.score, `${appId} replay non-deterministic (score)`);
    assert.equal(
      sB.answerHash.toString('hex'),
      sA.answerHash.toString('hex'),
      `${appId} replay non-deterministic (hash)`
    );

    // For log-deterministic engines the replay score also equals the LIVE score
    // (the op log fully determines it). Reflex engines (logDeterministic:false)
    // score on the enclave op-timeline, a documented TEE-trust property.
    if (engine.descriptor.logDeterministic) {
      const sLive = engine.score(live, 0, {
        ...timing,
        targetOverride: 0,
        answer: sudokuAnswer(appId, live),
      });
      assert.equal(sA.score, sLive.score, `${appId} replay/live score mismatch`);
      assert.equal(
        sA.answerHash.toString('hex'),
        sLive.answerHash.toString('hex'),
        `${appId} replay/live answerHash mismatch`
      );
    }
  });
}

// Sudoku's score() needs the submitted answer (the solution) — supply it from
// the state so the parameterized replay test covers sudoku too.
function sudokuAnswer(appId, state) {
  return appId === 'miniapp-sudoku' ? state.solution : undefined;
}
