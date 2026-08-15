// GENERATED from neo-os-minigames/apps/merge-kingdom/src/logic/merge-engine.ts by scripts/sync-miniapp-game-engines.mjs — DO NOT EDIT.
// Source sha256: 971562a07259a4d706acefc4a717d91a931cc6bfb1c6fbb5b7239c8b8252b071. After a reviewed upstream change, re-run this sync and the parity goldens.
// apps/merge-kingdom/src/logic/game-rules.ts
var BOARD_SIZE = 4;

// apps/merge-kingdom/src/logic/merge-engine.ts
var MAX_RENDERED_TILE = 4096;
function cloneBoard(board) {
  return Array.from(
    { length: BOARD_SIZE },
    (_, row) => Array.from({ length: BOARD_SIZE }, (_2, col) => Number(board[row]?.[col] ?? 0))
  );
}
function boardFromSessionView(view) {
  if (!view || typeof view !== "object") return null;
  const record = view;
  const nested = record.view && typeof record.view === "object" ? record.view : null;
  let candidate = nested?.board ?? record.board;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  if (Array.isArray(candidate) && candidate.length === BOARD_SIZE * BOARD_SIZE) {
    const flat = candidate;
    candidate = Array.from(
      { length: BOARD_SIZE },
      (_, row) => flat.slice(row * BOARD_SIZE, (row + 1) * BOARD_SIZE)
    );
  }
  if (!isValidBoard(candidate)) return null;
  return cloneBoard(candidate);
}
function isValidBoard(value) {
  if (!Array.isArray(value) || value.length !== BOARD_SIZE) return false;
  return value.every((row) => Array.isArray(row) && row.length === BOARD_SIZE && row.every((raw) => {
    if (typeof raw !== "number") return false;
    const tile = raw;
    return Number.isInteger(tile) && tile >= 0 && tile <= MAX_RENDERED_TILE && (tile === 0 || (tile & tile - 1) === 0);
  }));
}
function highestTile(board) {
  let best = 0;
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      best = Math.max(best, Number(board[row]?.[col] ?? 0));
    }
  }
  return best;
}
function emptyCells(board) {
  const cells = [];
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      if (Number(board[row]?.[col] ?? 0) === 0) cells.push({ row, col });
    }
  }
  return cells;
}
function isCellInRange(cell) {
  return Number.isInteger(cell.row) && Number.isInteger(cell.col) && cell.row >= 0 && cell.row < BOARD_SIZE && cell.col >= 0 && cell.col < BOARD_SIZE;
}
function isOrthogonalAdjacent(from, to) {
  if (!isCellInRange(from) || !isCellInRange(to)) return false;
  return Math.abs(from.row - to.row) + Math.abs(from.col - to.col) === 1;
}
function classifyMove(board, from, to) {
  if (!isOrthogonalAdjacent(from, to)) return null;
  const source = Number(board[from.row]?.[from.col] ?? 0);
  const destination = Number(board[to.row]?.[to.col] ?? 0);
  if (source <= 0) return null;
  if (destination === 0) return "reposition";
  return destination === source ? "merge" : null;
}
function hasMergePotential(board) {
  const counts = /* @__PURE__ */ new Map();
  let hasEmpty = false;
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      const value = Number(board[row]?.[col] ?? 0);
      if (value <= 0) {
        hasEmpty = true;
        continue;
      }
      counts.set(value, (counts.get(value) ?? 0) + 1);
      if (col + 1 < BOARD_SIZE && Number(board[row]?.[col + 1] ?? 0) === value) return true;
      if (row + 1 < BOARD_SIZE && Number(board[row + 1]?.[col] ?? 0) === value) return true;
    }
  }
  return hasEmpty && [...counts.values()].some((count) => count >= 2);
}
function applyMergeMove(sourceBoard, from, to, pickSpawn) {
  const kind = classifyMove(sourceBoard, from, to);
  if (!kind) return null;
  const board = cloneBoard(sourceBoard);
  const source = board[from.row]?.[from.col] ?? 0;
  board[from.row][from.col] = 0;
  board[to.row][to.col] = kind === "merge" ? source * 2 : source;
  let spawn = null;
  if (kind === "merge" && pickSpawn) {
    const free = emptyCells(board);
    if (free.length > 0) {
      const picked = pickSpawn(free);
      const cell = free.find(
        (candidate) => candidate.row === picked.cell.row && candidate.col === picked.cell.col
      ) ?? free[0];
      const value = picked.value === 4 ? 4 : 2;
      board[cell.row][cell.col] = value;
      spawn = { cell, value };
    }
  }
  return {
    board,
    kind,
    mergedValue: kind === "merge" ? source * 2 : null,
    spawn,
    highestTile: highestTile(board),
    canContinue: hasMergePotential(board)
  };
}
export {
  applyMergeMove,
  boardFromSessionView,
  classifyMove,
  cloneBoard,
  emptyCells,
  hasMergePotential,
  highestTile,
  isCellInRange,
  isOrthogonalAdjacent,
  isValidBoard
};
