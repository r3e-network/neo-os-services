// Sudoku engine — ABI wrapper over the deterministic core in engines/sudoku.js.
// No logic change to the core: the wrapper only adapts dealPuzzle to the fixed
// engine ABI and carries the per-game descriptor (constants moved out of the
// old session.js).
import { ScoreRejection, answerHashOf, DEFAULT_GATES } from '../abi.js';
import { dealPuzzle } from '../engines/sudoku.js';

export const appId = 'miniapp-sudoku';

export const descriptor = Object.freeze({
  opSchema: "place: {type:'place', cell:0..80, digit:1..9} | undo",
  targets: [0, 0, 0], // solved/not — the answer check is exact, no numeric target
  timeWindow: {
    limitMs: [900_000, 1_500_000, 2_400_000],
    minSolveMs: [90_000, 150_000, 240_000],
  },
  gates: { ...DEFAULT_GATES },
  revealPolicy: 'clues',
  maxOps: 20_000,
  maxUndos: 3,
  undoPenaltyPct: 30,
  logDeterministic: true,
  startConfigKey: null, // no numeric target surfaced at start
});

export function deal(problemSecret, difficulty) {
  const dealt = dealPuzzle(problemSecret, difficulty);
  return {
    state: { puzzle: dealt.puzzle, solution: dealt.solution, placements: [] },
    startView: { clues: dealt.puzzle },
  };
}

export function applyOp(state, op, _opMeta) {
  const type = typeof op?.type === 'string' ? op.type.trim() : '';
  if (type !== 'place') {
    return { state, reject: { message: 'op.type must be place or undo', status: 400 } };
  }
  const cell = Number(op.cell);
  const digit = Number(op.digit);
  if (!Number.isInteger(cell) || cell < 0 || cell > 80) {
    return { state, reject: { message: 'op.cell must be an integer 0..80', status: 400 } };
  }
  if (!Number.isInteger(digit) || digit < 1 || digit > 9) {
    return { state, reject: { message: 'op.digit must be an integer 1..9', status: 400 } };
  }
  if (state.puzzle.charAt(cell) !== '0') {
    return { state, reject: { message: 'cannot place on a clue cell', status: 400 } };
  }
  state.placements.push({ cell, digit });
  // No correctness feedback by design — the TEE only records the placement.
  return { state, view: { ok: true } };
}

export function applyUndo(state, _opMeta) {
  if (state.placements.length === 0) {
    return { state, reject: { message: 'nothing to undo', status: 409 } };
  }
  state.placements.pop();
  return { state, view: { ok: true } };
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

export function score(state, _difficulty, { answer } = {}) {
  // The authenticated op-log is the settlement input. Reconstruct the board
  // from clues plus the last accepted placement for every open cell; an
  // optional client answer is only a consistency assertion and is never the
  // source of truth for the payout.
  const board = state.puzzle.split('');
  for (const placement of state.placements) {
    board[placement.cell] = String(placement.digit);
  }
  const derived = board.join('');
  if (typeof answer === 'string' && answer.trim() !== derived) {
    throw new ScoreRejection('answer does not match the recorded placements', 403);
  }
  if (derived !== state.solution) {
    throw new ScoreRejection('incorrect solution', 403);
  }
  return { answerHash: answerHashOf(derived), score: 1 };
}
