// GENERATED from neo-os-minigames/apps/curve-arrow/src/logic/arrow-engine.ts by scripts/sync-miniapp-game-engines.mjs — DO NOT EDIT.
// Source sha256: 0b740bf206a65b64cb8572a11ff343e7b041e138f69738a9b6468a97b8e1c9d3. After a reviewed upstream change, re-run this sync and the parity goldens.
// apps/curve-arrow/src/logic/arrow-engine.ts
var FIELD_W = 1600;
var FIELD_H = 900;
var BOW = { x: 140, y: 450 };
var SPEED_Q8 = 3584;
var TURN_SIN = 286;
var TURN_COS = 4086;
var TICKS_MAX = 480;
var TARGET_RINGS = [18, 40, 70];
var MAX_HOLD_PAIRS = 6;
var LEVEL_TARGETS = [3, 5, 7];
var ARROW_BUDGETS = [9, 14, 19];
function normalizeHolds(holds) {
  if (!Array.isArray(holds)) return null;
  if (holds.length % 2 !== 0) return null;
  if (holds.length > MAX_HOLD_PAIRS * 2) return null;
  let prev = -1;
  for (const value of holds) {
    if (!Number.isInteger(value)) return null;
    if (value < 0 || value >= TICKS_MAX) return null;
    if (value <= prev) return null;
    prev = value;
  }
  return [...holds];
}
function isHeld(holds, tick) {
  for (let i = 0; i + 1 < holds.length; i += 2) {
    if (tick >= holds[i] && tick < holds[i + 1]) return true;
  }
  return false;
}
function rectContains(rect, x, y) {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}
function ringOf(offset) {
  const abs = offset < 0 ? -offset : offset;
  for (let ring = 0; ring < TARGET_RINGS.length; ring += 1) {
    if (abs <= TARGET_RINGS[ring]) return ring;
  }
  return -1;
}
function simulateShot(level, holds, options = {}) {
  const normalized = normalizeHolds(holds) ?? [];
  const path = [];
  let posX = BOW.x << 8;
  let posY = BOW.y << 8;
  let vx = SPEED_Q8;
  let vy = 0;
  let ticks = 0;
  let worldX = BOW.x;
  let worldY = BOW.y;
  let prevWorldX = BOW.x;
  for (let tick = 0; tick < TICKS_MAX; tick += 1) {
    if (isHeld(normalized, tick)) {
      const nvx = vx * TURN_COS + vy * TURN_SIN >> 12;
      const nvy = -vx * TURN_SIN + vy * TURN_COS >> 12;
      vx = nvx;
      vy = nvy;
    } else if (vy < 0) {
      const nvx = vx * TURN_COS - vy * TURN_SIN >> 12;
      const nvy = vx * TURN_SIN + vy * TURN_COS >> 12;
      if (nvy >= 0 && nvx > 0) {
        vx = SPEED_Q8;
        vy = 0;
        posY = posY >> 8 << 8;
      } else {
        vx = nvx;
        vy = nvy;
      }
    }
    posX += vx;
    posY += vy;
    prevWorldX = worldX;
    worldX = posX >> 8;
    worldY = posY >> 8;
    ticks = tick + 1;
    if (options.collectPath) path.push({ x: worldX, y: worldY });
    if (worldX < 0 || worldX > FIELD_W || worldY < 0 || worldY > FIELD_H) {
      worldX = Math.max(0, Math.min(FIELD_W, worldX));
      worldY = Math.max(0, Math.min(FIELD_H, worldY));
      return { hit: false, ring: -1, ticks, end: { x: worldX, y: worldY }, path };
    }
    for (const obstacle of level.obstacles) {
      if (rectContains(obstacle, worldX, worldY)) {
        return { hit: false, ring: -1, ticks, end: { x: worldX, y: worldY }, path };
      }
    }
    const crossedForward = prevWorldX < level.target.x && worldX >= level.target.x;
    const crossedBackward = prevWorldX > level.target.x && worldX <= level.target.x;
    if (crossedForward || crossedBackward) {
      const ring = ringOf(worldY - level.target.y);
      if (ring >= 0) {
        return { hit: true, ring, ticks, end: { x: worldX, y: worldY }, path };
      }
    }
  }
  return { hit: false, ring: -1, ticks, end: { x: worldX, y: worldY }, path };
}
function createRun(levels, difficulty) {
  const clamped = Math.max(0, Math.min(2, difficulty | 0));
  return {
    levelIndex: 0,
    cleared: 0,
    arrowsUsed: 0,
    budget: ARROW_BUDGETS[clamped],
    done: levels.length === 0,
    won: false
  };
}
function applyShot(run, levels, holds) {
  if (run.done || run.levelIndex >= levels.length) {
    return {
      run,
      outcome: { hit: false, ring: -1, ticks: 0, end: { ...BOW }, path: [] }
    };
  }
  const outcome = simulateShot(levels[run.levelIndex], holds);
  const arrowsUsed = run.arrowsUsed + 1;
  const cleared = outcome.hit ? run.cleared + 1 : run.cleared;
  const levelIndex = outcome.hit ? run.levelIndex + 1 : run.levelIndex;
  const won = cleared >= levels.length;
  const done = won || arrowsUsed >= run.budget;
  return {
    run: { levelIndex, cleared, arrowsUsed, budget: run.budget, done, won },
    outcome
  };
}
function runToSolutionString(run) {
  return `arrow:${run.cleared}:${run.arrowsUsed}`;
}
function isFiniteInt(value) {
  return typeof value === "number" && Number.isInteger(value);
}
function parseVec(raw) {
  const record = raw;
  if (!record || !isFiniteInt(record.x) || !isFiniteInt(record.y)) return null;
  if (record.x < 0 || record.x > FIELD_W || record.y < 0 || record.y > FIELD_H) return null;
  return { x: record.x, y: record.y };
}
function parseObstacle(raw) {
  const record = raw;
  if (!record) return null;
  if (!isFiniteInt(record.x) || !isFiniteInt(record.y) || !isFiniteInt(record.w) || !isFiniteInt(record.h)) {
    return null;
  }
  if (record.w <= 0 || record.h <= 0) return null;
  if (record.x < 0 || record.x + record.w > FIELD_W) return null;
  if (record.y < 0 || record.y + record.h > FIELD_H) return null;
  return { x: record.x, y: record.y, w: record.w, h: record.h };
}
function parseInitialState(cluesJson) {
  if (!cluesJson) return null;
  let raw;
  try {
    raw = JSON.parse(cluesJson);
  } catch {
    return null;
  }
  const record = raw;
  if (!record || !Array.isArray(record.levels)) return null;
  if (record.levels.length < 1 || record.levels.length > 7) return null;
  const levels = [];
  for (const rawLevel of record.levels) {
    const levelRecord = rawLevel;
    if (!levelRecord) return null;
    const target = parseVec(levelRecord.target);
    if (!target) return null;
    const rawObstacles = Array.isArray(levelRecord.obstacles) ? levelRecord.obstacles : null;
    if (!rawObstacles) return null;
    const obstacles = [];
    for (const rawObstacle of rawObstacles) {
      const obstacle = parseObstacle(rawObstacle);
      if (!obstacle) return null;
      obstacles.push(obstacle);
    }
    levels.push({ target, obstacles });
  }
  return { levels };
}
export {
  ARROW_BUDGETS,
  BOW,
  FIELD_H,
  FIELD_W,
  LEVEL_TARGETS,
  MAX_HOLD_PAIRS,
  SPEED_Q8,
  TARGET_RINGS,
  TICKS_MAX,
  TURN_COS,
  TURN_SIN,
  applyShot,
  createRun,
  isHeld,
  normalizeHolds,
  parseInitialState,
  runToSolutionString,
  simulateShot
};
