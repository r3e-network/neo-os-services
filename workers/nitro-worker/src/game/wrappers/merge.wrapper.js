// Merge Kingdom engine — ABI wrapper over the deterministic core in
// engines/merge.adapter.js (move/merge rules generated from the TS twin in
// engines/merge.js; the enclave-only spawn stream lives in the adapter).
// Reveal-per-move: the next spawn is disclosed only after a
// merge, never up front.
import { ScoreRejection, answerHashOf, resolveTarget, DEFAULT_GATES } from '../abi.js';
import { mergeAnswer, newBoard, replayMerge, stepMerge, toGrid } from '../engines/merge.adapter.js';

export const appId = 'miniapp-merge-kingdom';

export const descriptor = Object.freeze({
  opSchema: "move: {type:'move', from:{row,col}, to:{row,col}} | undo",
  targets: [64, 256, 1024], // highest tile value
  timeWindow: {
    limitMs: [180_000, 300_000, 600_000],
    minSolveMs: [30_000, 60_000, 120_000],
  },
  gates: { ...DEFAULT_GATES },
  revealPolicy: 'per-move',
  maxOps: 20_000,
  maxUndos: 3,
  undoPenaltyPct: 30,
  logDeterministic: true,
  startConfigKey: 'target_tile',
});

export function deal(problemSecret, _difficulty) {
  const state = { problemSecret, merge: newBoard(problemSecret), merges: [] };
  return { state, startView: { board: toGrid(state.merge.board) } };
}

// Rebuild the live merge state (with the correct rng cursor) from a move log.
function rebuildMergeState(problemSecret, moves) {
  let state = newBoard(problemSecret);
  for (const m of moves) {
    const next = stepMerge(problemSecret, state, m.from, m.to);
    if (!next) break;
    state = { board: next.board, rng: next.rng, maxTile: next.maxTile };
  }
  return state;
}

export function applyOp(state, op, _opMeta) {
  const type = typeof op?.type === 'string' ? op.type.trim() : '';
  if (type !== 'move') {
    return { state, reject: { message: 'op.type must be move or undo', status: 400 } };
  }
  const from = op.from;
  const to = op.to;
  if (!from || !to || typeof from !== 'object' || typeof to !== 'object') {
    return {
      state,
      reject: { message: 'op.from and op.to must be {row,col} objects', status: 400 },
    };
  }
  const move = {
    from: { row: Number(from.row), col: Number(from.col) },
    to: { row: Number(to.row), col: Number(to.col) },
  };
  const next = stepMerge(state.problemSecret, state.merge, move.from, move.to);
  if (!next) return { state, view: { ok: false } };
  state.merge = { board: next.board, rng: next.rng, maxTile: next.maxTile };
  state.merges.push(move);
  const view = {
    ok: true,
    merged: next.merged,
    view: { board: toGrid(next.board) },
    tile: next.maxTile,
  };
  if (next.spawn) view.spawn = next.spawn;
  return { state, view };
}

export function applyUndo(state, _opMeta) {
  if (state.merges.length === 0) {
    return { state, reject: { message: 'nothing to undo', status: 409 } };
  }
  state.merges.pop();
  state.merge = rebuildMergeState(state.problemSecret, state.merges);
  return { state, view: { ok: true, view: { board: toGrid(state.merge.board) } } };
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
  const replayed = replayMerge(state.problemSecret, state.merges);
  if (!replayed.ok) throw new ScoreRejection('invalid merge log', 403);
  const target = resolveTarget(descriptor.targets, difficulty, extra);
  if (replayed.maxTile < target) throw new ScoreRejection('target tile not reached', 403);
  return {
    answerHash: answerHashOf(mergeAnswer(replayed.maxTile, state.merges)),
    score: replayed.maxTile,
    scoreField: { tile_achieved: replayed.maxTile },
  };
}
