// Curve Arrow engine — HANDWRITTEN adapter over the GENERATED rule core in
// engines/arrow.js (bundled from neo-os-minigames curve-arrow
// arrow-engine.ts by scripts/sync-miniapp-game-engines.mjs — never edit that
// file; the curve-arrow twin, NOT arrow-escape, is the source — the flight
// math matches byte-for-byte).
//
// The shared rules (holds validation, Q8/Q12 flight physics, run bookkeeping)
// come from the generated core. The DEAL — targets and vertical walls drawn
// from a counter-mode SHA-256 stream over the secret, with the layout margins
// that keep every dealt level clearable with a single press/release pair — is
// enclave-only (the client parses clues; it never deals) and stays here, as do
// the clues view, the shots-log replay and the canonical answer string. This
// module preserves the historical engines/arrow.js export surface.
import { createHash } from 'node:crypto';
import {
  FIELD_W,
  FIELD_H,
  BOW,
  SPEED_Q8,
  TURN_SIN,
  TURN_COS,
  TICKS_MAX,
  TARGET_RINGS,
  MAX_HOLD_PAIRS,
  LEVEL_TARGETS,
  ARROW_BUDGETS,
  normalizeHolds,
  isHeld,
  simulateShot,
  createRun,
  applyShot,
} from './arrow.js';

export {
  FIELD_W,
  FIELD_H,
  BOW,
  SPEED_Q8,
  TURN_SIN,
  TURN_COS,
  TICKS_MAX,
  TARGET_RINGS,
  MAX_HOLD_PAIRS,
  LEVEL_TARGETS,
  ARROW_BUDGETS,
  normalizeHolds,
  isHeld,
  simulateShot,
  createRun,
  applyShot,
};

// ── Deal layout constants (enclave-only) ─────────────────────────────────────

const OBSTACLE_W = 36;
const MAX_OBSTACLES = 4;
const MAX_OBSTACLE_ATTEMPTS = 40;
/** Min squared-distance clearance between a wall rect and the target point. */
const TARGET_CLEARANCE = 110;
/** Min horizontal separation between accepted walls in one level. */
const X_SEPARATION = 90;
/** Vertical clearance every wall keeps from the target's flight band. */
const BAND_MARGIN = 90;

// ── Secret stream (counter-mode SHA-256, identical to the snake engine) ──────

function streamOf(seed) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) {
    throw new Error('seed must be 32 bytes');
  }
  let k = 0;
  let cursor = 32;
  let block = null;
  return {
    next() {
      if (cursor >= 32) {
        const input = Buffer.alloc(36);
        Buffer.from(seed).copy(input, 0);
        input[32] = (k >>> 24) & 0xff;
        input[33] = (k >>> 16) & 0xff;
        input[34] = (k >>> 8) & 0xff;
        input[35] = k & 0xff;
        block = createHash('sha256').update(input).digest();
        k += 1;
        cursor = 0;
      }
      const byte = block[cursor] ?? 0;
      cursor += 1;
      return byte;
    },
  };
}

function u16(stream) {
  return (stream.next() << 8) | stream.next();
}

// ── Deal (enclave-only) ───────────────────────────────────────────────────────

function clampInt(value, lo, hi) {
  return value < lo ? lo : value > hi ? hi : value;
}

// A wall is accepted only when it keeps TARGET_CLEARANCE from the target point
// (rect-to-point distance) AND clears the target's flight band vertically by
// BAND_MARGIN, so a single-pair shot can always level out inside the ring band
// and fly over (or under) every wall.
function wallAcceptable(tx, ty, ox, oy, oh) {
  const dx = clampInt(tx, ox, ox + OBSTACLE_W) - tx;
  const dy = clampInt(ty, oy, oy + oh) - ty;
  if (dx * dx + dy * dy < TARGET_CLEARANCE * TARGET_CLEARANCE) return false;
  const aboveBand = oy + oh <= ty - BAND_MARGIN;
  const belowBand = oy >= ty + BAND_MARGIN;
  return aboveBand || belowBand;
}

function separated(obstacles, ox) {
  for (const rect of obstacles) {
    const gap = ox >= rect.x ? ox - rect.x : rect.x - ox;
    if (gap < X_SEPARATION) return false;
  }
  return true;
}

/**
 * Deal the level layouts from the secret: per level a ring target on the right
 * band and up to min(1 + (i >> 1), 4) vertical walls (up to 40 stream attempts
 * per wall slot; a slot that never draws an acceptable wall is skipped). Pure
 * function of (secret, difficulty) so repeated starts return the same clues.
 */
export function dealArrow(problemSecret, difficulty) {
  const clamped = Math.max(0, Math.min(2, difficulty | 0));
  const stream = streamOf(problemSecret);
  const levelCount = LEVEL_TARGETS[clamped];
  const levels = [];

  for (let i = 0; i < levelCount; i += 1) {
    const tx = 1180 + (u16(stream) % 340);
    const ty = 160 + (u16(stream) % 340);
    const wanted = Math.min(1 + (i >> 1), MAX_OBSTACLES);
    const obstacles = [];
    for (let slot = 0; slot < wanted; slot += 1) {
      for (let attempt = 0; attempt < MAX_OBSTACLE_ATTEMPTS; attempt += 1) {
        const ox = 420 + (u16(stream) % 640);
        const oh = 240 + (u16(stream) % 300);
        const oy = u16(stream) % (FIELD_H - oh);
        if (!wallAcceptable(tx, ty, ox, oy, oh)) continue;
        if (!separated(obstacles, ox)) continue;
        obstacles.push({ x: ox, y: oy, w: OBSTACLE_W, h: oh });
        break;
      }
    }
    levels.push({ target: { x: tx, y: ty }, obstacles });
  }

  return { levels };
}

/** The clues JSON the frontend arrow-engine.parseInitialState consumes. */
export function arrowCluesView(problemSecret, difficulty) {
  return JSON.stringify(dealArrow(problemSecret, difficulty));
}

/**
 * Replay a shots log (array of holds arrays) from the deal. A shot that ends
 * the run stops the replay; returns the final run plus the applied count.
 */
export function replayArrow(problemSecret, difficulty, shots) {
  const { levels } = dealArrow(problemSecret, difficulty);
  let run = createRun(levels, difficulty);
  let applied = 0;
  for (const holds of shots) {
    if (run.done) break;
    run = applyShot(run, levels, holds).run;
    applied += 1;
    if (run.done) break;
  }
  return {
    run,
    cleared: run.cleared,
    arrowsUsed: run.arrowsUsed,
    done: run.done,
    won: run.won,
    applied,
  };
}

/** Canonical answer string the enclave hashes for SETTLE. */
export function arrowAnswer(cleared, arrowsUsed) {
  return `arrow:${cleared}:${arrowsUsed}`;
}
