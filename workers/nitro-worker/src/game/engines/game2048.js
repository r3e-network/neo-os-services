// GENERATED from neo-os-minigames/apps/game-2048/src/logic/engine-2048.ts by scripts/sync-miniapp-game-engines.mjs — DO NOT EDIT.
// Source sha256: 98fdc9604d14fe321b9226586e309b71a2e1244dd5fc5c60fd63f3bb6a214799. After a reviewed upstream change, re-run this sync and the parity goldens.
// apps/game-2048/src/logic/engine-2048.ts
var BOARD_CELLS = 16;
var MAX_TILE_EXPONENT = 30;
function isValidBoard(value) {
  return Array.isArray(value) && value.length === BOARD_CELLS && value.every((cell) => Number.isInteger(cell) && cell >= 0 && cell <= MAX_TILE_EXPONENT);
}
function requireBoard(value) {
  if (!isValidBoard(value)) throw new Error("invalid 2048 board payload");
  return [...value];
}
function isValidSpawn(value) {
  if (!value || typeof value !== "object") return false;
  const spawn = value;
  return Number.isInteger(spawn.pos) && Number(spawn.pos) >= 0 && Number(spawn.pos) < BOARD_CELLS && (spawn.exp === 1 || spawn.exp === 2);
}
var MOVE_UP = 0;
var MOVE_RIGHT = 1;
var MOVE_DOWN = 2;
var MOVE_LEFT = 3;
var MOVE_ANIMATION_MS = 340;
function lineIndices(dir) {
  const lines = [];
  for (let a = 0; a < 4; a += 1) {
    const line = [];
    for (let b = 0; b < 4; b += 1) {
      if (dir === MOVE_LEFT) line.push(a * 4 + b);
      else if (dir === MOVE_RIGHT) line.push(a * 4 + (3 - b));
      else if (dir === MOVE_UP) line.push(b * 4 + a);
      else line.push((3 - b) * 4 + a);
    }
    lines.push(line);
  }
  return lines;
}
function traceSlide(board, dir) {
  if (!isValidBoard(board) || !Number.isInteger(dir) || dir < 0 || dir > 3) return null;
  const before = [...board];
  const afterSlide = new Array(BOARD_CELLS).fill(0);
  const motions = [];
  const merges = [];
  let changed = false;
  for (const idx of lineIndices(dir)) {
    const tiles = idx.map((source) => ({ source, exponent: before[source] ?? 0 })).filter((tile) => tile.exponent > 0);
    let destinationOffset = 0;
    for (let i = 0; i < tiles.length; i += 1) {
      const current = tiles[i];
      const next = tiles[i + 1];
      const destination = idx[destinationOffset];
      if (next && current.exponent === next.exponent) {
        const merge = merges.length;
        motions.push(
          {
            source: current.source,
            destination,
            exponent: current.exponent,
            merge
          },
          {
            source: next.source,
            destination,
            exponent: next.exponent,
            merge
          }
        );
        merges.push({
          sources: [current.source, next.source],
          destination,
          sourceExponent: current.exponent,
          resultExponent: current.exponent + 1
        });
        afterSlide[destination] = current.exponent + 1;
        changed = true;
        i += 1;
      } else {
        motions.push({
          source: current.source,
          destination,
          exponent: current.exponent,
          merge: null
        });
        afterSlide[destination] = current.exponent;
        if (current.source !== destination) changed = true;
      }
      destinationOffset += 1;
    }
  }
  return changed ? { before, afterSlide, motions, merges } : null;
}
function createMoveTransition(board, dir, spawn, sequence) {
  const slide = traceSlide(board, dir);
  if (!slide) return null;
  if (!Number.isSafeInteger(sequence) || sequence < 0) return null;
  if (!isValidSpawn(spawn)) return null;
  if ((slide.afterSlide[spawn.pos] ?? 0) !== 0) return null;
  const after = [...slide.afterSlide];
  after[spawn.pos] = spawn.exp;
  return {
    sequence,
    direction: dir,
    before: slide.before,
    afterSlide: slide.afterSlide,
    after,
    motions: slide.motions,
    merges: slide.merges,
    spawn: { destination: spawn.pos, exponent: spawn.exp }
  };
}
function applyMove(board, dir) {
  const trace = traceSlide(board, dir);
  if (!trace) return false;
  for (let index = 0; index < 16; index += 1) {
    board[index] = trace.afterSlide[index] ?? 0;
  }
  return true;
}
function hasAnyMove(board) {
  for (let dir = 0; dir < 4; dir += 1) {
    if (applyMove([...board], dir)) return true;
  }
  return false;
}
function boardHex(board) {
  if (!isValidBoard(board) || board.some((value) => value > 15)) return "";
  return board.map((v) => (v & 15).toString(16)).join("");
}
function movesToString(moves) {
  return moves.every((move) => Number.isInteger(move) && move >= 0 && move <= 3) ? moves.map((move) => String(move)).join("") : "";
}
function tileValue(exp) {
  return Number.isInteger(exp) && exp > 0 && exp <= MAX_TILE_EXPONENT ? 2 ** exp : 0;
}
export {
  BOARD_CELLS,
  MAX_TILE_EXPONENT,
  MOVE_ANIMATION_MS,
  MOVE_DOWN,
  MOVE_LEFT,
  MOVE_RIGHT,
  MOVE_UP,
  applyMove,
  boardHex,
  createMoveTransition,
  hasAnyMove,
  isValidBoard,
  isValidSpawn,
  movesToString,
  requireBoard,
  tileValue
};
