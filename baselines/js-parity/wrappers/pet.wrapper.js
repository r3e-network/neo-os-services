// Pet Potion engine — ABI wrapper over the deterministic core in engines/pet.js.
// Deterministic care deltas with a real-time per-action spacing gate: care
// actions closer than MIN_ACTION_GAP_MS apart (enclave clock) are rejected. The
// spacing state (lastActionMs) lives in the engine state; the enclave clock
// arrives via opMeta.nowMs. Resumed (replay) sessions are exempt at op time (no
// timestamps) — the finalize behavioural gate still applies.
import { ScoreRejection, answerHashOf, resolveTarget, DEFAULT_GATES } from '../abi.js';
import {
  ACTION_INDEX,
  ACTIONS as PET_ACTIONS,
  MIN_ACTION_GAP_MS,
  newPet,
  petAnswer,
  replayPet,
  stageOf,
  stepPet,
} from '../engines/pet.js';

export const appId = 'miniapp-pet-potion';

export const descriptor = Object.freeze({
  opSchema: "care: {type:'feed'|'play'|'pet'|'rest'} | undo",
  targets: [50, 70, 100], // peak happiness
  timeWindow: {
    limitMs: [180_000, 300_000, 600_000],
    minSolveMs: [30_000, 60_000, 120_000],
  },
  gates: { ...DEFAULT_GATES, minActionGapMs: MIN_ACTION_GAP_MS },
  revealPolicy: 'state-only',
  maxOps: 20_000,
  maxUndos: 3,
  undoPenaltyPct: 30,
  logDeterministic: true,
  startConfigKey: 'target_happiness',
});

export function deal(_problemSecret, _difficulty) {
  const pet = newPet();
  return {
    state: { pet, petPeak: pet.happiness, actions: [], lastActionMs: null },
    startView: {
      happiness: pet.happiness,
      hunger: pet.hunger,
      energy: pet.energy,
      stage: stageOf(pet.happiness),
    },
  };
}

export function applyOp(state, op, opMeta = {}) {
  const name = typeof op?.type === 'string' ? op.type.trim() : '';
  if (!PET_ACTIONS.includes(name)) {
    return {
      state,
      reject: { message: 'op.type must be feed, play, pet, rest or undo', status: 400 },
    };
  }
  // Real-time action spacing (burst gate at op time). Resumed sessions replayed
  // without timing are exempt here (the finalize behavioural gate still applies).
  const nowMs = opMeta.nowMs;
  if (
    !opMeta.resumed &&
    state.lastActionMs !== null &&
    Number.isFinite(nowMs) &&
    nowMs - state.lastActionMs < MIN_ACTION_GAP_MS
  ) {
    return { state, reject: { message: 'care actions must be spaced out', status: 429 } };
  }
  if (Number.isFinite(nowMs)) state.lastActionMs = nowMs;
  state.pet = stepPet(state.pet, name);
  if (state.pet.happiness > state.petPeak) state.petPeak = state.pet.happiness;
  state.actions.push(ACTION_INDEX[name]);
  return {
    state,
    view: {
      ok: true,
      view: {
        happiness: state.pet.happiness,
        hunger: state.pet.hunger,
        energy: state.pet.energy,
        stage: stageOf(state.pet.happiness),
      },
    },
  };
}

export function applyUndo(state, _opMeta) {
  if (state.actions.length === 0) {
    return { state, reject: { message: 'nothing to undo', status: 409 } };
  }
  state.actions.pop();
  const rebuilt = replayPet(state.actions);
  state.pet = rebuilt.state;
  state.petPeak = rebuilt.peak;
  return {
    state,
    view: {
      ok: true,
      view: {
        happiness: state.pet.happiness,
        hunger: state.pet.hunger,
        energy: state.pet.energy,
        stage: stageOf(state.pet.happiness),
      },
    },
  };
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
  const replayed = replayPet(state.actions);
  const target = resolveTarget(descriptor.targets, difficulty, extra);
  if (replayed.peak < target) throw new ScoreRejection('happiness target not reached', 403);
  return {
    answerHash: answerHashOf(petAnswer(replayed.peak, state.actions)),
    score: replayed.peak,
    scoreField: { happiness_achieved: replayed.peak },
  };
}
