// Confidential-session engine ABI — the fixed contract every game engine
// implements as DATA the generic session host loads by (appId, engineHash).
//
// The host (session.js) knows NOTHING about any specific game: it derives the
// problemSecret, records op timestamps, runs the behavioural gate, enforces the
// time window and undo bounds from the engine's descriptor, and builds the
// 79-byte finalize result. All per-game behaviour — the deal, the per-op reveal,
// the undo rebuild, the deterministic replay and the score derivation — lives in
// the engine, keyed off a static descriptor of per-game constants.
//
// ABI (each engine module exports these):
//
//   deal(problemSecret, difficulty) -> { state, startView }
//     Build the initial in-enclave state and the start view (what the client is
//     allowed to see at the start — never future secrets). Pure function of the
//     secret + difficulty.
//
//   applyOp(state, op, opMeta) -> { state, view, reject? }
//     Apply ONE non-undo gameplay op to a live state. `opMeta` carries the
//     enclave-derived timing the host owns:
//       { problemSecret, difficulty, nowMs, startedAtMs, elapsedMs, resumed,
//         opIndex }
//     Returns the next state, the per-op view (reveal-per-move payload) and,
//     when the op is illegal, a `reject` { message, status }. A returned
//     `view.ok === false` (no reject) marks an accepted-but-null op (a move that
//     changed nothing) — the host records it like the legacy game handler did.
//
//   applyUndo(state, opMeta) -> { state, view, reject? }
//     Undo the last recorded op (engine-specific rebuild). Same opMeta. The host
//     enforces the maxUndos cap from the descriptor BEFORE calling this and
//     counts the undo; the engine only rebuilds its own state.
//
//   replay(problemSecret, opLog) -> state
//     Deterministically rebuild the full state from the accepted op log. Used
//     for the cache-miss session recovery path AND (authoritatively) at
//     finalize by the kernel re-derivation. Throws on an op the live session
//     would have rejected.
//
//   score(state, difficulty) -> { answerHash, score, scoreField? }
//     Derive the enclave-authoritative { answerHash (32-byte Buffer), score
//     (uint32) } from the final state, or throw a ScoreRejection when the run
//     did not reach the difficulty target. `scoreField` is optional extra JSON
//     the /session/step-less finalize response surfaces for the client.
//
//   descriptor = {
//     opSchema:      free-form doc of the accepted op shapes (informational),
//     targets:       [t0, t1, t2] score targets per difficulty,
//     timeWindow:    { limitMs: [..3], minSolveMs: [..3] } TEE-clock bounds,
//     gates:         { minMedianIntervalMs, maxBurstOpsPerSec, minActionGapMs? },
//     revealPolicy:  'seed' | 'clues' | 'per-move' | 'per-round' | 'state-only',
//     maxOps:        cap on the op log length,
//     maxUndos:      undo cap,
//     undoPenaltyPct: payout penalty percent per undo (informational; the
//                     contract applies it — mirrored here for cross-checking),
//     startConfigKey: the config field name the start response exposes the
//                     target under (e.g. 'target_pipes'),
//   }

import { createHash } from 'node:crypto';

// A ScoreRejection signals "run did not meet the target / invalid log" — the
// host maps it to a 403. Any other throw is an engine bug (500-class).
export class ScoreRejection extends Error {
  constructor(message, status = 403) {
    super(message);
    this.name = 'ScoreRejection';
    this.status = status;
  }
}

// sha256 of a UTF-8 answer string -> the 32-byte answerHash every engine binds.
export function answerHashOf(str) {
  return createHash('sha256').update(str, 'utf8').digest();
}

// Resolve the effective score target for a difficulty: the host may pass a
// targetOverride (test/operator-tuned lower target) via score()'s extra arg;
// otherwise the engine's descriptor target for that difficulty applies.
export function resolveTarget(descriptorTargets, difficulty, extra = {}) {
  const override = extra?.targetOverride;
  return Number.isFinite(override) ? override : descriptorTargets[difficulty];
}

// Shared behavioural-gate defaults — engines override per-genre via descriptor.
export const DEFAULT_GATES = Object.freeze({
  minMedianIntervalMs: 120,
  maxBurstOpsPerSec: 12,
});

export const DEFAULT_MAX_OPS = 20_000;
export const DEFAULT_MAX_UNDOS = 3;
export const DEFAULT_UNDO_PENALTY_PCT = 30;
