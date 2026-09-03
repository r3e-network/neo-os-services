// Jump Rush engine — ABI wrapper over engines/jump.adapter.js (layout
// generation + jump evaluation generated from the TS twin in engines/jump.js;
// secret normalization and replay live in the adapter).
import { ScoreRejection, DEFAULT_GATES, answerHashOf, resolveTarget } from '../abi.js';
import { generatePlatforms, evaluateJump } from '../engines/jump.adapter.js';

export const appId = 'miniapp-jump-rush';

export const descriptor = Object.freeze({
  opSchema: "jump: {type:'jump', chargeLevel:0..100}",
  targets: [15, 25, 35], // number of platforms to clear per difficulty
  timeWindow: {
    limitMs: [180_000, 300_000, 480_000],
    minSolveMs: [20_000, 40_000, 60_000],
  },
  gates: { ...DEFAULT_GATES },
  revealPolicy: 'clues',
  maxOps: 200,
  maxUndos: 0,
  undoPenaltyPct: 0,
  logDeterministic: true,
  startConfigKey: 'target_platforms',
});

export function deal(problemSecret, difficulty) {
  const diff = Number(difficulty) || 0;
  const platforms = generatePlatforms(problemSecret, diff);
  // Send only the first platform's info to the client initially (reveal-on-move)
  return {
    state: {
      problemSecret,
      difficulty: diff,
      platforms,
      platformIndex: 0,
      jumps: 0,
      perfects: 0,
      failed: false,
      completed: false,
    },
    startView: {
      platforms: platforms.map((p) => ({ x: p.x, width: p.width, gap: p.gap })),
      totalPlatforms: platforms.length,
      targetPlatforms: descriptor.targets[diff] ?? 15,
    },
  };
}

export function applyOp(state, op, _opMeta) {
  const type = typeof op?.type === 'string' ? op.type.trim() : '';
  if (type !== 'jump') {
    return { state, reject: { message: "op.type must be 'jump'", status: 400 } };
  }

  const chargeLevel = Number(op.chargeLevel);
  if (!Number.isFinite(chargeLevel) || chargeLevel < 0 || chargeLevel > 100) {
    return { state, reject: { message: 'op.chargeLevel must be a number 0..100', status: 400 } };
  }

  if (state.failed || state.completed) {
    return { state, reject: { message: 'game is already over', status: 409 } };
  }

  const result = evaluateJump(state.platforms, state.platformIndex, chargeLevel);
  state.jumps++;

  if (!result.ok) {
    state.failed = true;
    return {
      state,
      view: {
        ok: false,
        landed: false,
        perfect: false,
        platformIndex: state.platformIndex,
        jumps: state.jumps,
        perfects: state.perfects,
        failed: true,
      },
    };
  }

  if (result.perfect) state.perfects++;
  state.platformIndex++;

  const target = descriptor.targets[state.difficulty] ?? 15;
  state.completed = state.platformIndex >= target;

  return {
    state,
    view: {
      ok: true,
      landed: true,
      perfect: result.perfect,
      platformIndex: state.platformIndex,
      jumps: state.jumps,
      perfects: state.perfects,
      completed: state.completed,
    },
  };
}

export function applyUndo(_state, _opMeta) {
  return { _state, reject: { message: 'undo not supported in Jump Rush', status: 405 } };
}

export function replay(problemSecret, opLog, difficulty = 0) {
  const { state } = deal(problemSecret, difficulty);
  for (let i = 0; i < opLog.length; i++) {
    const op = opLog[i];
    const outcome = applyOp(state, op);
    if (outcome.reject) throw new Error(`invalid op at index ${i}: ${outcome.reject.message}`);
    if (state.failed || state.completed) break;
  }
  return state;
}

export function score(state, difficulty, extra = {}) {
  // Default target = descriptor.targets[difficulty], the same threshold that
  // latches state.completed in applyOp, so production strictness is unchanged;
  // targetOverride is honored like every other wrapper.
  const target = resolveTarget(descriptor.targets, difficulty, extra);
  if (state.platformIndex < target) {
    throw new ScoreRejection('course not completed — reach the target platform count to win');
  }
  return {
    answerHash: answerHashOf(`jump:${state.platformIndex}:${state.perfects}:${state.jumps}`),
    score: state.platformIndex,
    scoreField: {
      platforms_cleared: state.platformIndex,
      perfects: state.perfects,
      jumps: state.jumps,
    },
  };
}
