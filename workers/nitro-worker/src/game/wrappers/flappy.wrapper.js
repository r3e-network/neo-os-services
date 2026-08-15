// Flappy Dash engine — ABI wrapper over the deterministic core in
// engines/flappy.js. Reflex genre: the host supplies the enclave-clock elapsed
// time per op (opMeta.elapsedMs) and the engine maps each flap onto its 60fps
// frame; the finalize replay steps the physics to the authoritative score.
import { ScoreRejection, answerHashOf, resolveTarget, DEFAULT_GATES } from '../abi.js';
import { FRAME_MS, flappyAnswer, replayFlappy, seedString } from '../engines/flappy.js';

export const appId = 'miniapp-flappy-dash';

export const descriptor = Object.freeze({
  opSchema: "flap: {type:'flap'} | undo",
  targets: [5, 10, 20], // pipes passed
  timeWindow: {
    limitMs: [120_000, 180_000, 300_000],
    minSolveMs: [20_000, 30_000, 45_000],
  },
  gates: { ...DEFAULT_GATES },
  revealPolicy: 'seed',
  maxOps: 20_000,
  maxUndos: 3,
  undoPenaltyPct: 30,
  logDeterministic: false, // reflex: score depends on enclave op-timing the log does not carry
  startConfigKey: 'target_pipes',
});

export function deal(problemSecret, _difficulty) {
  return {
    state: { problemSecret, flapFrames: [] },
    startView: { seed: seedString(problemSecret) },
  };
}

// Reflex frame assignment uses the enclave's OWN clock (opMeta.elapsedMs); a
// client-claimed frame is never trusted. On the replay-recovery path the host
// has no timestamps, so opMeta.resumed reconstructs a nominal cadence.
export function applyOp(state, op, opMeta = {}) {
  const type = typeof op?.type === 'string' ? op.type.trim() : '';
  if (type !== 'flap') {
    return { state, reject: { message: 'op.type must be flap or undo', status: 400 } };
  }
  const frame = opMeta.resumed
    ? (state.flapFrames.length + 1) * 12
    : Math.max(1, Math.round((opMeta.elapsedMs ?? 0) / FRAME_MS));
  state.flapFrames.push(frame);
  return { state, view: { ok: true } };
}

export function applyUndo(state, _opMeta) {
  if (state.flapFrames.length === 0) {
    return { state, reject: { message: 'nothing to undo', status: 409 } };
  }
  state.flapFrames.pop();
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
  const { elapsedMs, startedAtMs, nowMs } = extra;
  // Cap the simulation at the enclave-clock frame reached at finalize.
  const spanMs = Number.isFinite(elapsedMs)
    ? elapsedMs
    : Math.max(0, (nowMs ?? 0) - (startedAtMs ?? 0));
  const maxFrame = Math.ceil(spanMs / FRAME_MS);
  const seed = seedString(state.problemSecret);
  const run = replayFlappy(seed, state.flapFrames, maxFrame);
  const target = resolveTarget(descriptor.targets, difficulty, extra);
  if (run.pipesPassed < target) {
    throw new ScoreRejection('target pipes not reached', 403);
  }
  const answerHash = answerHashOf(flappyAnswer(run.pipesPassed, state.flapFrames));
  return {
    answerHash,
    score: run.pipesPassed,
    scoreField: { pipes_passed: run.pipesPassed, state_hash: answerHash.toString('hex') },
  };
}
