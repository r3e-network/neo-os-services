// 2048 engine — ABI wrapper over the deterministic core in
// engines/game2048.adapter.js (slide/merge rules generated from the TS twin in
// engines/game2048.js; the enclave-only spawn stream lives in the adapter).
import { ScoreRejection, answerHashOf, resolveTarget, DEFAULT_GATES } from '../abi.js';
import { movesToString, newRun, replayRun, stepRun } from '../engines/game2048.adapter.js';

export const appId = 'miniapp-game-2048';

export const descriptor = Object.freeze({
  opSchema: "move: {type:'move', dir:0..3} | undo",
  targets: [9, 10, 11], // maxExp thresholds → 512 / 1024 / 2048
  timeWindow: {
    limitMs: [240_000, 480_000, 900_000],
    minSolveMs: [60_000, 120_000, 240_000],
  },
  gates: { ...DEFAULT_GATES },
  revealPolicy: 'per-move',
  maxOps: 20_000,
  maxUndos: 3,
  undoPenaltyPct: 30,
  logDeterministic: true,
  startConfigKey: 'target_exp',
});

export function deal(problemSecret, _difficulty) {
  const run = newRun(problemSecret);
  return {
    state: { problemSecret, run, moves: [] },
    startView: { board: run.board },
  };
}

export function applyOp(state, op, _opMeta) {
  const type = typeof op?.type === 'string' ? op.type.trim() : '';
  if (type !== 'move') {
    return { state, reject: { message: 'op.type must be move or undo', status: 400 } };
  }
  const dir = Number(op.dir);
  if (!Number.isInteger(dir) || dir < 0 || dir > 3) {
    return {
      state,
      reject: {
        message: 'op.dir must be an integer 0..3 (0=up 1=right 2=down 3=left)',
        status: 400,
      },
    };
  }
  const next = stepRun(state.problemSecret, state.run, dir);
  if (!next) return { state, view: { ok: false } };
  state.run = { board: next.board, rng: next.rng, maxExp: next.maxExp };
  state.moves.push(dir);
  return { state, view: { ok: true, spawn: next.spawn, board: next.board } };
}

export function applyUndo(state, _opMeta) {
  if (state.moves.length === 0) {
    return { state, reject: { message: 'nothing to undo', status: 409 } };
  }
  state.moves.pop();
  const rebuilt = replayRun(state.problemSecret, state.moves);
  state.run = { board: rebuilt.board, rng: rebuilt.rng, maxExp: rebuilt.maxExp };
  return { state, view: { ok: true, board: state.run.board } };
}

export function replay(problemSecret, opLog, difficulty = 0) {
  const { state } = deal(problemSecret, difficulty);
  for (let i = 0; i < opLog.length; i += 1) {
    const op = opLog[i];
    const type = typeof op?.type === 'string' ? op.type.trim() : '';
    const outcome = type === 'undo' ? applyUndo(state) : applyOp(state, op);
    if (outcome.reject || outcome.view?.ok === false) {
      throw new Error(`invalid replay op at index ${i}`);
    }
  }
  return state;
}

export function score(state, difficulty, extra = {}) {
  const target = resolveTarget(descriptor.targets, difficulty, extra);
  if (state.run.maxExp < target) {
    throw new ScoreRejection('target tile not reached', 403);
  }
  return {
    answerHash: answerHashOf(movesToString(state.moves)),
    score: state.run.maxExp,
  };
}
