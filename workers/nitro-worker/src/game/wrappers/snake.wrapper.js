// Snake Bounty engine — ABI wrapper over the deterministic core in
// engines/snake.adapter.js (shared rules generated from the TS twin in
// engines/snake.js; the enclave-only deal lives in the adapter).
import { ScoreRejection, answerHashOf, resolveTarget, DEFAULT_GATES } from '../abi.js';
import { dealSnake, replaySnake, snakeAnswer, snakeCluesView } from '../engines/snake.adapter.js';

export const appId = 'miniapp-snake-bounty';

export const descriptor = Object.freeze({
  opSchema: "move: {type:'move', dir:0..3} | undo",
  targets: [10, 20, 35], // snake length
  timeWindow: {
    limitMs: [180_000, 300_000, 600_000],
    minSolveMs: [20_000, 40_000, 60_000],
  },
  gates: { ...DEFAULT_GATES },
  revealPolicy: 'clues',
  maxOps: 20_000,
  maxUndos: 3,
  undoPenaltyPct: 30,
  logDeterministic: true,
  startConfigKey: 'target_length',
});

export function deal(problemSecret, _difficulty) {
  return {
    state: { problemSecret, deal: dealSnake(problemSecret), dirs: [] },
    startView: { clues: snakeCluesView(problemSecret) },
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
  state.dirs.push(dir);
  const rebuilt = replaySnake(state.problemSecret, state.dirs);
  return {
    state,
    view: {
      ok: true,
      body: rebuilt.state.body,
      food: rebuilt.state.food,
      eaten: rebuilt.eaten,
      length: rebuilt.length,
      dead: rebuilt.dead,
    },
  };
}

export function applyUndo(state, _opMeta) {
  if (state.dirs.length === 0) {
    return { state, reject: { message: 'nothing to undo', status: 409 } };
  }
  state.dirs.pop();
  const rebuilt = replaySnake(state.problemSecret, state.dirs);
  return {
    state,
    view: { ok: true, body: rebuilt.state.body, food: rebuilt.state.food, eaten: rebuilt.eaten },
  };
}

export function replay(problemSecret, opLog, difficulty = 0) {
  const { state } = deal(problemSecret, difficulty);
  for (let i = 0; i < opLog.length; i += 1) {
    const op = opLog[i];
    const type = typeof op?.type === 'string' ? op.type.trim() : '';
    const outcome = type === 'undo' ? applyUndo(state) : applyOp(state, op);
    if (outcome.reject) throw new Error(`invalid replay op at index ${i}`);
  }
  return state;
}

export function score(state, difficulty, extra = {}) {
  const replayed = replaySnake(state.problemSecret, state.dirs);
  const target = resolveTarget(descriptor.targets, difficulty, extra);
  if (replayed.length < target) {
    throw new ScoreRejection('target length not reached', 403);
  }
  return {
    answerHash: answerHashOf(snakeAnswer(replayed.length, state.dirs)),
    score: replayed.length,
    scoreField: { length: replayed.length, eaten: replayed.eaten },
  };
}
