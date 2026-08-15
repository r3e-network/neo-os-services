// Merge Kingdom engine — HANDWRITTEN adapter over the GENERATED rule core in
// engines/merge.js (bundled from neo-os-minigames merge-engine.ts by
// scripts/sync-miniapp-game-engines.mjs — never edit that file).
//
// The shared rules (move classification, merge/reposition application) come
// from the generated core. The counter-mode SHA-256 spawn stream, the flat
// 16-cell board representation and the answer string are enclave-side and stay
// here. This module preserves the historical engines/merge.js export surface —
// including the FLAT spawn cell index the per-move view exposes.
import { createHash } from 'node:crypto';
import { applyMergeMove } from './merge.js';

// Mirrors merge-kingdom game-rules.ts BOARD_SIZE (the generated core uses the
// same constant internally; it is not part of merge-engine.ts's exports).
export const BOARD_SIZE = 4;
const CELLS = BOARD_SIZE * BOARD_SIZE;
const INITIAL_TILES = 4; // opening tiles seeded from the stream

function streamOf(seed, resume) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) {
    throw new Error('seed must be 32 bytes');
  }
  let k = resume ? resume.k : 0;
  let cursor = resume ? resume.cursor : 32;
  let block = resume && resume.cursor < 32 && resume.k > 0 ? blockOf(seed, resume.k - 1) : null;
  function blockOf(s, kk) {
    const input = Buffer.alloc(36);
    Buffer.from(s).copy(input, 0);
    input[32] = (kk >>> 24) & 0xff;
    input[33] = (kk >>> 16) & 0xff;
    input[34] = (kk >>> 8) & 0xff;
    input[35] = kk & 0xff;
    return createHash('sha256').update(input).digest();
  }
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

// ENCLAVE-ONLY spawn: one cell drawn among the free cells (row-major order —
// the same order the generated core's emptyCells enumerates) plus a value byte
// (4 when byte % 10 == 0, else 2).
function spawnInto(board, stream) {
  const free = [];
  for (let i = 0; i < CELLS; i += 1) if (board[i] === 0) free.push(i);
  if (free.length === 0) return null;
  const cell = free[stream.next() % free.length];
  const value = stream.next() % 10 === 0 ? 4 : 2;
  board[cell] = value;
  return { cell, value };
}

/** A fresh board (flat 16-length) with the opening tiles from the stream. */
export function newBoard(problemSecret) {
  const stream = streamOf(problemSecret);
  const board = new Array(CELLS).fill(0);
  for (let i = 0; i < INITIAL_TILES; i += 1) spawnInto(board, stream);
  return { board, rng: stream.state(), maxTile: Math.max(...board) };
}

/** Flat board → 4×4 grid the frontend renders (view.board). */
export function toGrid(flat) {
  const grid = [];
  for (let r = 0; r < BOARD_SIZE; r += 1) {
    grid.push(flat.slice(r * BOARD_SIZE, r * BOARD_SIZE + BOARD_SIZE));
  }
  return grid;
}

function toFlat(grid) {
  return grid.flat();
}

function idx(row, col) {
  return row * BOARD_SIZE + col;
}

function inRange(v) {
  return Number.isInteger(v) && v >= 0 && v < BOARD_SIZE;
}

/**
 * Apply one move to a live state over the GENERATED applyMergeMove core. Two
 * legal shapes (mirroring the frontend "move to empty OR merge with same
 * value"):
 *   - reposition: `to` is empty → the tile slides there. No spawn is consumed.
 *   - merge: `to` holds an EQUAL value → the tiles combine (value doubles) and
 *     the enclave consumes ONE spawn from the stream, revealed in the response.
 * Returns the next state with the consumed spawn (flat cell index, or null for
 * a reposition) and a `merged` flag, or null when the move is illegal.
 */
export function stepMerge(problemSecret, state, from, to) {
  if (!from || !to) return null;
  if (!inRange(from.row) || !inRange(from.col) || !inRange(to.row) || !inRange(to.col)) {
    return null;
  }
  const grid = toGrid(state.board);
  const fi = idx(from.row, from.col);
  if (state.board[fi] === 0) return null; // nothing to move

  const stream = streamOf(problemSecret, state.rng);
  const result = applyMergeMove(grid, from, to, (empty) => {
    const picked = empty[stream.next() % empty.length] ?? empty[0];
    return { cell: picked, value: stream.next() % 10 === 0 ? 4 : 2 };
  });
  if (!result) return null;

  const board = toFlat(result.board);
  if (result.kind === 'reposition') {
    return { board, rng: state.rng, maxTile: state.maxTile, spawn: null, merged: false };
  }
  return {
    board,
    rng: stream.state(),
    maxTile: Math.max(state.maxTile, ...board),
    spawn: result.spawn
      ? { cell: idx(result.spawn.cell.row, result.spawn.cell.col), value: result.spawn.value }
      : null,
    merged: true,
  };
}

/**
 * Full-run replay from the accepted move log. Each move is {from,to}. A move
 * that would be illegal returns ok:false. Returns the final board/maxTile.
 */
export function replayMerge(problemSecret, moves) {
  let state = newBoard(problemSecret);
  let applied = 0;
  for (const m of moves) {
    const next = stepMerge(problemSecret, state, m.from, m.to);
    if (!next) return { ok: false, board: state.board, maxTile: state.maxTile, applied };
    state = { board: next.board, rng: next.rng, maxTile: next.maxTile };
    applied += 1;
  }
  return { ok: true, board: state.board, maxTile: state.maxTile, applied };
}

/** Canonical answer string the enclave hashes for SETTLE. */
export function mergeAnswer(maxTile, moves) {
  const encoded = moves.map((m) => `${m.from.row}${m.from.col}${m.to.row}${m.to.col}`).join(',');
  return `merge:${maxTile}:${encoded}`;
}
