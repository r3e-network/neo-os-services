// Snake Bounty engine — HANDWRITTEN adapter over the GENERATED rule core in
// engines/snake.js (bundled from neo-os-minigames snake-engine.ts by
// scripts/sync-miniapp-game-engines.mjs — never edit that file).
//
// The shared rules (step() collision/growth semantics, grid constants) come
// from the generated core. Everything keyed off the 32-byte problemSecret —
// the counter-mode SHA-256 deal, the clues view, the replay accounting and the
// canonical answer string — is enclave-only (the frontend consumes clues; it
// has no deal twin) and stays here. This module preserves the historical
// engines/snake.js export surface, so wrappers/tests keep working unchanged.
import { createHash } from 'node:crypto';
import { GRID_SIZE, step } from './snake.js';

export { GRID_SIZE };

// Enough food to cover the hardest target (35) with generous headroom.
const FOOD_QUEUE_LEN = 64;
const INITIAL_LENGTH = 3;

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

function pointKey(p) {
  return p.y * GRID_SIZE + p.x;
}

/**
 * Build the deterministic opening position from the secret: a horizontal snake
 * of INITIAL_LENGTH heading right, centred, then a food queue of distinct cells
 * that never land on the initial body. Pure function of the secret so repeated
 * starts return the same clues. ENCLAVE-ONLY — no upstream TS twin.
 */
export function dealSnake(problemSecret) {
  const stream = streamOf(problemSecret);
  const headX = 8 + (stream.next() % 4); // 8..11 — keeps room to the right
  const headY = 6 + (stream.next() % 8); // 6..13
  const body = [];
  for (let i = 0; i < INITIAL_LENGTH; i += 1) {
    body.push({ x: headX - i, y: headY });
  }
  const occupied = new Set(body.map(pointKey));

  const foodCells = [];
  const claim = (p) => {
    const key = pointKey(p);
    if (occupied.has(key)) return false;
    occupied.add(key);
    foodCells.push(p);
    return true;
  };

  let guard = 0;
  while (foodCells.length < FOOD_QUEUE_LEN && guard < 100000) {
    guard += 1;
    const x = stream.next() % GRID_SIZE;
    const y = stream.next() % GRID_SIZE;
    claim({ x, y });
  }

  const food = foodCells[0];
  const foodQueue = foodCells.slice(1);
  return {
    body,
    direction: 1,
    food,
    foodQueue,
    initialLength: INITIAL_LENGTH,
  };
}

/** The clues JSON the frontend snake-engine.parseInitialState consumes. */
export function snakeCluesView(problemSecret) {
  const dealt = dealSnake(problemSecret);
  return JSON.stringify({
    body: dealt.body,
    direction: dealt.direction,
    food: dealt.food,
    foodQueue: dealt.foodQueue,
  });
}

function freshState(dealt) {
  return {
    body: dealt.body.map((p) => ({ ...p })),
    direction: dealt.direction,
    food: { ...dealt.food },
    foodQueue: dealt.foodQueue.map((p) => ({ ...p })),
    dead: false,
    eaten: 0,
  };
}

/**
 * Advance one move over the GENERATED step() core. Returns { state, changed }.
 * `changed` is false when the move is out of range, the snake is dead, or the
 * direction is a direct reversal into the neck (rejected, no-op) — this mirrors
 * classic snake input filtering and lets the session ignore such ops. The
 * generated step() is immutable and returns a JSON-equal copy on a no-op, so
 * `changed` is detected by value.
 */
export function stepSnake(state, direction) {
  if (state.dead) return { state, changed: false };
  if (!Number.isInteger(direction) || direction < 0 || direction > 3) {
    return { state, changed: false };
  }
  const next = step(state, direction);
  const changed = JSON.stringify(next) !== JSON.stringify(state);
  if (!changed || next.dead) return { state: next, changed };
  // The old port rebuilt changed states with exactly these six fields (any
  // extra caller-held fields are dropped); project to preserve that contract.
  return {
    state: {
      body: next.body,
      direction: next.direction,
      food: next.food,
      foodQueue: next.foodQueue,
      dead: next.dead,
      eaten: next.eaten,
    },
    changed,
  };
}

/**
 * Replay the accepted move directions from the deal. Returns the final state
 * plus { eaten, length, dead }. A move that kills the snake ends the replay.
 */
export function replaySnake(problemSecret, dirs) {
  const dealt = dealSnake(problemSecret);
  let state = freshState(dealt);
  let applied = 0;
  for (const dir of dirs) {
    if (state.dead) break;
    const { state: next, changed } = stepSnake(state, dir);
    if (!changed) continue;
    state = next;
    applied += 1;
    if (state.dead) break;
  }
  return {
    state,
    eaten: state.eaten,
    length: state.body.length,
    dead: state.dead,
    applied,
    initialLength: dealt.initialLength,
  };
}

/** Canonical answer string the enclave hashes for SETTLE. */
export function snakeAnswer(length, dirs) {
  return `snake:${length}:${dirs.join('')}`;
}
