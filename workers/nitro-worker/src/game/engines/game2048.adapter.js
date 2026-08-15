// 2048 engine — HANDWRITTEN adapter over the GENERATED rule core in
// engines/game2048.js (bundled from neo-os-minigames engine-2048.ts by
// scripts/sync-miniapp-game-engines.mjs — never edit that file).
//
// The shared slide/merge rules (applyMove and the MOVE_* constants) come from
// the generated core. The counter-mode SHA-256 spawn stream and the run
// bookkeeping (newRun/stepRun/replayRun) are enclave-only — the frontend never
// sees the stream — and stay here. This module preserves the historical
// engines/game2048.js export surface.
import { createHash } from 'node:crypto';
import { applyMove, MOVE_UP, MOVE_RIGHT, MOVE_DOWN, MOVE_LEFT, movesToString } from './game2048.js';

export { applyMove, MOVE_UP, MOVE_RIGHT, MOVE_DOWN, MOVE_LEFT, movesToString };

function blockOf(seed, k) {
  const input = Buffer.alloc(36);
  Buffer.from(seed).copy(input, 0);
  input[32] = (k >>> 24) & 0xff;
  input[33] = (k >>> 16) & 0xff;
  input[34] = (k >>> 8) & 0xff;
  input[35] = k & 0xff;
  return createHash('sha256').update(input).digest();
}

// ENCLAVE-ONLY spawn stream: block k = sha256(seed || k as 4-byte big-endian).
// Every valid move consumes exactly one spawn (two stream bytes: position index
// over the FREE cells, then the value byte — 4 when byte % 10 == 0, else 2).
function streamOf(seed, resume) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) {
    throw new Error('seed must be 32 bytes');
  }
  let k = resume ? resume.k : 0;
  let cursor = resume ? resume.cursor : 32;
  // Resuming mid-block means re-deriving the block k-1 that cursor points at.
  let block = resume && resume.cursor < 32 && resume.k > 0 ? blockOf(seed, resume.k - 1) : null;
  return {
    next() {
      if (cursor >= 32) {
        block = blockOf(seed, k);
        k += 1;
        cursor = 0;
      }
      const byte = block[cursor] ?? 0;
      cursor += 1;
      return byte;
    },
    state: () => ({ k, cursor }),
  };
}

function spawnInto(board, stream) {
  const free = [];
  for (let i = 0; i < 16; i += 1) if (board[i] === 0) free.push(i);
  if (free.length === 0) throw new Error('spawn on full board');
  const pos = free[stream.next() % free.length] ?? 0;
  board[pos] = stream.next() % 10 === 0 ? 2 : 1;
  return { pos, exp: board[pos] };
}

/** Fresh run: two spawns off the head of the stream. */
export function newRun(seed) {
  const stream = streamOf(seed);
  const board = new Array(16).fill(0);
  spawnInto(board, stream);
  spawnInto(board, stream);
  return { board, rng: stream.state(), maxExp: Math.max(...board) };
}

/**
 * Apply one player move to a live run. Returns the next state (with the
 * consumed spawn reported as { pos, exp }), or null when the move does not
 * change the board (invalid — no spawn is consumed).
 */
export function stepRun(seed, state, dir) {
  const board = [...state.board];
  if (!applyMove(board, dir)) return null;
  const stream = streamOf(seed, state.rng);
  const spawn = spawnInto(board, stream);
  return { board, rng: stream.state(), maxExp: Math.max(state.maxExp, ...board), spawn };
}

/** Full-run replay — every move must be board-changing or ok is false. */
export function replayRun(seed, moves) {
  const stream = streamOf(seed);
  const board = new Array(16).fill(0);
  spawnInto(board, stream);
  spawnInto(board, stream);
  let maxExp = Math.max(...board);
  let applied = 0;
  for (const m of moves) {
    if (m < 0 || m > 3 || !applyMove(board, m)) {
      return { ok: false, board, rng: stream.state(), maxExp, applied };
    }
    spawnInto(board, stream);
    applied += 1;
    for (const v of board) if (v > maxExp) maxExp = v;
  }
  return { ok: true, board, rng: stream.state(), maxExp, applied };
}
