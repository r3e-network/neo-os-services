// Curve Arrow engine — ABI wrapper over the deterministic core in
// engines/arrow.adapter.js (flight physics generated from the TS twin in
// engines/arrow.js; the enclave-only level deal lives in the adapter).
import { ScoreRejection, answerHashOf, resolveTarget, DEFAULT_GATES } from '../abi.js';
import {
  applyShot,
  arrowAnswer,
  arrowCluesView,
  createRun,
  dealArrow,
  normalizeHolds,
  replayArrow,
} from '../engines/arrow.adapter.js';

export const appId = 'miniapp-curve-arrow';

export const descriptor = Object.freeze({
  opSchema: "shot: {type:'shot', holds:[pressTick,releaseTick,...]} (no undo)",
  targets: [3, 5, 7], // levels cleared
  timeWindow: {
    limitMs: [180_000, 300_000, 600_000],
    minSolveMs: [10_000, 25_000, 45_000],
  },
  gates: { ...DEFAULT_GATES },
  revealPolicy: 'clues',
  maxOps: 64,
  maxUndos: 0,
  undoPenaltyPct: 0,
  logDeterministic: true,
  startConfigKey: 'target_levels',
});

export function deal(problemSecret, difficulty) {
  const diff = Math.max(0, Math.min(2, Number(difficulty) | 0));
  const { levels } = dealArrow(problemSecret, diff);
  return {
    state: {
      problemSecret,
      difficulty: diff,
      levels,
      run: createRun(levels, diff),
      shots: [],
    },
    startView: { clues: arrowCluesView(problemSecret, diff) },
  };
}

export function applyOp(state, op, _opMeta) {
  const type = typeof op?.type === 'string' ? op.type.trim() : '';
  if (type !== 'shot') {
    return { state, reject: { message: "op.type must be 'shot'", status: 400 } };
  }
  const holds = normalizeHolds(op.holds);
  if (holds === null) {
    return {
      state,
      reject: {
        message: 'op.holds must be up to 6 strictly ascending [press,release) tick pairs in 0..479',
        status: 400,
      },
    };
  }
  if (state.run.done) {
    return { state, reject: { message: 'run is already over', status: 409 } };
  }
  const { run, outcome } = applyShot(state.run, state.levels, holds);
  state.run = run;
  state.shots.push(holds);
  return {
    state,
    view: {
      ok: true,
      hit: outcome.hit,
      ring: outcome.ring,
      cleared: run.cleared,
      arrowsUsed: run.arrowsUsed,
      done: run.done,
      won: run.won,
    },
  };
}

export function applyUndo(state, _opMeta) {
  return { state, reject: { message: 'undo not supported', status: 400 } };
}

export function replay(problemSecret, opLog, difficulty = 0) {
  const { state } = deal(problemSecret, difficulty);
  for (let i = 0; i < opLog.length; i += 1) {
    const outcome = applyOp(state, opLog[i]);
    if (outcome.reject) throw new Error(`invalid replay op at index ${i}`);
  }
  return state;
}

export function score(state, difficulty, extra = {}) {
  const replayed = replayArrow(state.problemSecret, state.difficulty, state.shots);
  const target = resolveTarget(descriptor.targets, difficulty, extra);
  if (replayed.cleared < target) {
    throw new ScoreRejection('target not reached', 403);
  }
  return {
    answerHash: answerHashOf(arrowAnswer(replayed.cleared, replayed.arrowsUsed)),
    score: replayed.cleared,
    scoreField: { cleared: replayed.cleared, arrowsUsed: replayed.arrowsUsed },
  };
}
