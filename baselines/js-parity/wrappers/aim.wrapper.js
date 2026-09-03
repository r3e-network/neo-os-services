// Aim Master engine — ABI wrapper over the deterministic core in engines/aim.js.
// Reflex genre: each aim op is placed on the pattern timeline by the enclave's
// OWN clock tick (opMeta.elapsedMs / tickMs); the client-claimed position is
// never trusted for scoring.
import { ScoreRejection, answerHashOf, resolveTarget, DEFAULT_GATES } from '../abi.js';
import { AIM_CONFIG, aimAnswer, patternView, replayAim } from '../engines/aim.js';

export const appId = 'miniapp-aim-master';

export const descriptor = Object.freeze({
  opSchema: "aim: {type:'aim', position:0..width} | undo",
  targets: [3, 5, 7], // accuracy hits (ring <= 2)
  timeWindow: {
    limitMs: [60_000, 90_000, 120_000],
    minSolveMs: [10_000, 20_000, 30_000],
  },
  gates: { ...DEFAULT_GATES },
  revealPolicy: 'per-move',
  maxOps: 20_000,
  maxUndos: 3,
  undoPenaltyPct: 30,
  logDeterministic: false, // reflex: score depends on enclave op-timing the log does not carry
  startConfigKey: 'target_accuracy',
});

export function deal(problemSecret, _difficulty) {
  return {
    state: { problemSecret, ticks: [], ops: [] },
    startView: { pattern: patternView(problemSecret) },
  };
}

export function applyOp(state, op, opMeta = {}) {
  const type = typeof op?.type === 'string' ? op.type.trim() : '';
  if (type !== 'aim') {
    return { state, reject: { message: 'op.type must be aim or undo', status: 400 } };
  }
  const position = Number(op.position);
  if (!Number.isFinite(position) || position < 0 || position > AIM_CONFIG.width) {
    return {
      state,
      reject: { message: `op.position must be within 0..${AIM_CONFIG.width}`, status: 400 },
    };
  }
  // The client-claimed position is recorded but NOT trusted; the tick derived
  // from the enclave clock is what the engine scores.
  state.ops.push({ type: 'aim', position });
  const tick = opMeta.resumed
    ? (state.ticks.length + 1) * 30
    : Math.max(0, Math.round((opMeta.elapsedMs ?? 0) / AIM_CONFIG.tickMs));
  state.ticks.push(tick);
  return { state, view: { ok: true } };
}

export function applyUndo(state, _opMeta) {
  if (state.ticks.length === 0) {
    return { state, reject: { message: 'nothing to undo', status: 409 } };
  }
  state.ticks.pop();
  state.ops.pop();
  return { state, view: { ok: true } };
}

export function replay(problemSecret, opLog, difficulty = 0) {
  const { state } = deal(problemSecret, difficulty);
  for (let i = 0; i < opLog.length; i += 1) {
    const op = opLog[i];
    const type = typeof op?.type === 'string' ? op.type.trim() : '';
    const outcome = type === 'undo' ? applyUndo(state) : applyOp(state, op, { resumed: true });
    if (outcome.reject) throw new Error(`invalid replay op at index ${i}`);
  }
  return state;
}

export function score(state, difficulty, extra = {}) {
  const pattern = patternView(state.problemSecret).split(',').map(Number);
  const replayed = replayAim(pattern, state.ticks);
  const target = resolveTarget(descriptor.targets, difficulty, extra);
  if (replayed.accuracyHits < target) {
    throw new ScoreRejection('accuracy target not reached', 403);
  }
  return {
    answerHash: answerHashOf(aimAnswer(replayed.accuracyHits, replayed.rings)),
    score: replayed.accuracyHits,
    scoreField: { rings_hit: replayed.accuracyHits },
  };
}
