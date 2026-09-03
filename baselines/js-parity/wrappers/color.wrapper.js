// Color Clash engine — ABI wrapper over the deterministic core in
// engines/color.js. Reveal-per-round: start view.sequence is EMPTY; colours are
// revealed one per completed round via the per-op view.
import { ScoreRejection, answerHashOf, resolveTarget, DEFAULT_GATES } from '../abi.js';
import {
  colorAnswer,
  colorSequence,
  newColorState,
  pressColor,
  replayColor,
} from '../engines/color.js';

export const appId = 'miniapp-color-clash';

export const descriptor = Object.freeze({
  opSchema: "press: {type:'press', color:0..3} | undo",
  targets: [8, 12, 16], // longest completed round
  timeWindow: {
    limitMs: [120_000, 180_000, 300_000],
    minSolveMs: [15_000, 30_000, 45_000],
  },
  gates: { ...DEFAULT_GATES },
  revealPolicy: 'per-round',
  maxOps: 20_000,
  maxUndos: 3,
  undoPenaltyPct: 30,
  logDeterministic: true,
  startConfigKey: 'target_seq',
});

export function deal(problemSecret, _difficulty) {
  return {
    state: {
      problemSecret,
      sequence: colorSequence(problemSecret),
      color: newColorState(),
      presses: [],
    },
    // Reveal-per-round: the future sequence is NEVER handed over at start.
    startView: { sequence: '' },
  };
}

export function applyOp(state, op, _opMeta) {
  const type = typeof op?.type === 'string' ? op.type.trim() : '';
  if (type !== 'press') {
    return { state, reject: { message: 'op.type must be press or undo', status: 400 } };
  }
  const color = Number(op.color);
  if (!Number.isInteger(color) || color < 0 || color > 3) {
    return { state, reject: { message: 'op.color must be an integer 0..3', status: 400 } };
  }
  const result = pressColor(state.sequence, state.color, color);
  state.presses.push(color);
  const view = {
    ok: true,
    correct: result.ok === true,
    best: result.best ?? state.color.best,
    round: state.color.round,
  };
  if (result.wrong) view.wrong = true;
  if (result.roundComplete) view.round_complete = true;
  // Reveal ONLY the newly revealed colour (never the full future sequence).
  if (result.reveal !== undefined) {
    view.reveal = result.reveal;
    view.round = result.round;
  }
  return { state, view };
}

export function applyUndo(state, _opMeta) {
  if (state.presses.length === 0) {
    return { state, reject: { message: 'nothing to undo', status: 409 } };
  }
  state.presses.pop();
  // Rebuild the reveal state from the trimmed press log.
  const rebuilt = newColorState();
  for (const c of state.presses) {
    if (rebuilt.over) break;
    pressColor(state.sequence, rebuilt, c);
  }
  state.color = rebuilt;
  return { state, view: { ok: true, round: rebuilt.round, revealed: rebuilt.revealed } };
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
  const replayed = replayColor(state.problemSecret, state.presses);
  const target = resolveTarget(descriptor.targets, difficulty, extra);
  if (replayed.best < target) {
    throw new ScoreRejection('sequence target not reached', 403);
  }
  return {
    answerHash: answerHashOf(colorAnswer(replayed.best, state.presses)),
    score: replayed.best,
    scoreField: { seq_achieved: replayed.best },
  };
}
