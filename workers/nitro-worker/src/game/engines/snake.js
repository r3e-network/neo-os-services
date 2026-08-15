// GENERATED from neo-os-minigames/apps/snake-bounty/src/logic/snake-engine.ts by scripts/sync-miniapp-game-engines.mjs — DO NOT EDIT.
// Source sha256: 9ff41ea2956407fa1c2f483794a4d15ad2cdd757dd614e3fc9ba830c0f005f92. After a reviewed upstream change, re-run this sync and the parity goldens.
// apps/snake-bounty/src/logic/snake-engine.ts
var GRID_SIZE = 20;
var DIRECTION_VECTORS = {
  0: { x: 0, y: -1 },
  // up
  1: { x: 1, y: 0 },
  // right
  2: { x: 0, y: 1 },
  // down
  3: { x: -1, y: 0 }
  // left
};
var OPPOSITE_DIRECTION = {
  0: 2,
  // up <-> down
  1: 3,
  // right <-> left
  2: 0,
  3: 1
};
function pointOf(value, label) {
  if (!value || typeof value !== "object") throw new Error(`${label} must be a point`);
  const raw = value;
  const point = { x: Number(raw.x), y: Number(raw.y) };
  if (!Number.isInteger(point.x) || !Number.isInteger(point.y) || !inBounds(point)) {
    throw new Error(`${label} is outside the snake grid`);
  }
  return point;
}
function parseInitialState(cluesJson) {
  const data = JSON.parse(cluesJson);
  if (!Array.isArray(data.body) || data.body.length === 0) throw new Error("snake body is missing");
  if (data.body.length > GRID_SIZE * GRID_SIZE) throw new Error("snake body is too long");
  const body = data.body.map((point, index) => pointOf(point, `body[${index}]`));
  const occupied = /* @__PURE__ */ new Set();
  for (let index = 0; index < body.length; index += 1) {
    const point = body[index];
    const key = `${point.x},${point.y}`;
    if (occupied.has(key)) throw new Error("snake body contains overlapping segments");
    occupied.add(key);
    const previous = body[index - 1];
    if (previous && Math.abs(previous.x - point.x) + Math.abs(previous.y - point.y) !== 1) {
      throw new Error("snake body contains disconnected segments");
    }
  }
  const direction = Number(data.direction);
  if (!Number.isInteger(direction) || direction < 0 || direction > 3) {
    throw new Error("snake direction must be 0..3");
  }
  const foodQueue = data.foodQueue === void 0 ? [] : Array.isArray(data.foodQueue) ? data.foodQueue.map((point, index) => pointOf(point, `foodQueue[${index}]`)) : (() => {
    throw new Error("foodQueue must be an array");
  })();
  if (foodQueue.length > GRID_SIZE * GRID_SIZE) throw new Error("foodQueue is too long");
  const eaten = data.eaten === void 0 ? 0 : Number(data.eaten);
  if (!Number.isInteger(eaten) || eaten < 0 || eaten > GRID_SIZE * GRID_SIZE) {
    throw new Error("snake eaten count is invalid");
  }
  if (data.dead !== void 0 && typeof data.dead !== "boolean") {
    throw new Error("snake dead flag is invalid");
  }
  return {
    body,
    direction,
    food: pointOf(data.food, "food"),
    foodQueue,
    dead: data.dead === true,
    eaten
  };
}
function inBounds(p) {
  return p.x >= 0 && p.x < GRID_SIZE && p.y >= 0 && p.y < GRID_SIZE;
}
function overlapsBody(p, body, excludeHead = false) {
  const start = excludeHead ? 1 : 0;
  for (let i = start; i < body.length; i++) {
    const seg = body[i];
    if (seg && seg.x === p.x && seg.y === p.y) return true;
  }
  return false;
}
function step(state, direction) {
  if (state.dead) return { ...state };
  const vec = DIRECTION_VECTORS[direction];
  const head = state.body[0];
  if (!head) return { ...state };
  const newHead = { x: head.x + vec.x, y: head.y + vec.y };
  const neck = state.body[1];
  if (neck && newHead.x === neck.x && newHead.y === neck.y) return { ...state };
  if (!inBounds(newHead)) {
    return { ...state, direction, dead: true };
  }
  const willEat = newHead.x === state.food.x && newHead.y === state.food.y;
  if (willEat) {
    if (overlapsBody(newHead, state.body, false)) {
      return { ...state, direction, dead: true };
    }
    const newBody = [newHead, ...state.body.map((point) => ({ ...point }))];
    const nextFood = state.foodQueue.length > 0 ? state.foodQueue[0] : state.food;
    const newFoodQueue = state.foodQueue.length > 0 ? state.foodQueue.slice(1) : [];
    return {
      ...state,
      body: newBody,
      direction,
      food: nextFood,
      foodQueue: newFoodQueue,
      eaten: state.eaten + 1
    };
  } else {
    const bodyWithoutTail = state.body.slice(0, -1);
    if (overlapsBody(newHead, bodyWithoutTail, false)) {
      return { ...state, direction, dead: true };
    }
    const newBody = [newHead, ...bodyWithoutTail.map((point) => ({ ...point }))];
    return { ...state, body: newBody, direction };
  }
}
function replayDirections(initial, directions) {
  let current = {
    ...initial,
    body: initial.body.map((point) => ({ ...point })),
    food: { ...initial.food },
    foodQueue: initial.foodQueue.map((point) => ({ ...point }))
  };
  for (const rawDirection of directions) {
    if (current.dead) break;
    if (!Number.isInteger(rawDirection) || rawDirection < 0 || rawDirection > 3) continue;
    current = step(current, rawDirection);
  }
  return current;
}
function stateToClues(state) {
  return JSON.stringify({
    body: state.body,
    direction: state.direction,
    food: state.food,
    foodQueue: state.foodQueue,
    dead: state.dead,
    eaten: state.eaten
  });
}
function stateToSolutionString(state) {
  return JSON.stringify({
    body: state.body,
    direction: state.direction,
    eaten: state.eaten
  });
}
function snakeLength(state) {
  return state.body.length;
}
function hasReachedTarget(state, targetLength) {
  return state.body.length >= targetLength;
}
export {
  DIRECTION_VECTORS,
  GRID_SIZE,
  OPPOSITE_DIRECTION,
  hasReachedTarget,
  inBounds,
  overlapsBody,
  parseInitialState,
  replayDirections,
  snakeLength,
  stateToClues,
  stateToSolutionString,
  step
};
