// GENERATED from neo-os-minigames/apps/flappy-dash/src/logic/tee-engine-v1.ts by scripts/sync-miniapp-game-engines.mjs — DO NOT EDIT.
// Source sha256: 5e7f05226d8d78f1f2d8cd95d5f9060c0f39738ce2f176b5ce59b5614919fad8. After a reviewed upstream change, re-run this sync and the parity goldens.
// apps/flappy-dash/src/logic/tee-engine-v1.ts
var CANVAS_WIDTH = 400;
var CANVAS_HEIGHT = 600;
var GROUND_HEIGHT = 80;
var BIRD_WIDTH = 34;
var BIRD_HEIGHT = 24;
var BIRD_X = 80;
var PIPE_WIDTH = 52;
var FRAME_MS = 1e3 / 60;
var GRAVITY = 0.45;
var FLAP_VELOCITY = -7.2;
var MAX_FALL_VELOCITY = 10;
var BIRD_START_Y = CANVAS_HEIGHT / 2 - BIRD_HEIGHT / 2;
var PIPE_GAP = 140;
var PIPE_SPEED = 2.5;
var PIPE_SPAWN_INTERVAL = 100;
var MIN_PIPE_TOP = 60;
var MAX_PIPE_BOTTOM = CANVAS_HEIGHT - GROUND_HEIGHT - PIPE_GAP - 60;
var FIRST_SPAWN_FRAME = 60;
function hashSeed(seed) {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = Math.imul(31, hash) + seed.charCodeAt(index) | 0;
  }
  return hash >>> 0;
}
var SeededRandom = class {
  state;
  constructor(seed) {
    this.state = hashSeed(seed);
  }
  next() {
    this.state ^= this.state << 13;
    this.state ^= this.state >> 17;
    this.state ^= this.state << 5;
    return (this.state >>> 0) % 1e6 / 1e6;
  }
  nextInt(min, max) {
    return min + Math.floor(this.next() * (max - min + 1));
  }
};
function seedString(problemSecret) {
  if (!(problemSecret instanceof Uint8Array) || problemSecret.length !== 32) {
    throw new Error("problemSecret must be 32 bytes");
  }
  return Array.from(problemSecret, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function isPlaying(state) {
  return state.phase === "playing";
}
function isCrashed(state) {
  return state.phase === "crashed";
}
function createState(seed) {
  return {
    bird: { y: BIRD_START_Y, vy: 0, rotation: 0 },
    pipes: [],
    phase: "ready",
    score: 0,
    frame: 0,
    rng: new SeededRandom(seed),
    nextSpawnFrame: FIRST_SPAWN_FRAME
  };
}
function spawnPipe(state) {
  const gapY = state.rng.nextInt(MIN_PIPE_TOP, MAX_PIPE_BOTTOM);
  return { x: CANVAS_WIDTH, gapY, scored: false };
}
function rectOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}
function stepFrame(state) {
  if (state.phase !== "playing") return;
  state.frame += 1;
  const bird = state.bird;
  bird.vy += GRAVITY;
  if (bird.vy > MAX_FALL_VELOCITY) bird.vy = MAX_FALL_VELOCITY;
  bird.y += bird.vy;
  bird.rotation = Math.max(-25, Math.min(90, bird.vy * 3));
  if (bird.y + BIRD_HEIGHT >= CANVAS_HEIGHT - GROUND_HEIGHT) {
    bird.y = CANVAS_HEIGHT - GROUND_HEIGHT - BIRD_HEIGHT;
    state.phase = "crashed";
    return;
  }
  if (bird.y <= 0) {
    bird.y = 0;
    bird.vy = 0;
  }
  if (state.frame >= state.nextSpawnFrame) {
    state.pipes.push(spawnPipe(state));
    state.nextSpawnFrame = state.frame + PIPE_SPAWN_INTERVAL;
  }
  const pipes = state.pipes;
  for (let index = pipes.length - 1; index >= 0; index -= 1) {
    const pipe = pipes[index];
    pipe.x -= PIPE_SPEED;
    if (!pipe.scored && pipe.x + PIPE_WIDTH < BIRD_X) {
      pipe.scored = true;
      state.score += 1;
    }
    if (pipe.x + PIPE_WIDTH < 0) pipes.splice(index, 1);
  }
  for (const pipe of pipes) {
    if (rectOverlap(BIRD_X, bird.y, BIRD_WIDTH, BIRD_HEIGHT, pipe.x, 0, PIPE_WIDTH, pipe.gapY)) {
      state.phase = "crashed";
      return;
    }
    const bottomPipeY = pipe.gapY + PIPE_GAP;
    if (rectOverlap(
      BIRD_X,
      bird.y,
      BIRD_WIDTH,
      BIRD_HEIGHT,
      pipe.x,
      bottomPipeY,
      PIPE_WIDTH,
      CANVAS_HEIGHT - GROUND_HEIGHT - bottomPipeY
    )) {
      state.phase = "crashed";
      return;
    }
  }
}
function replayFlappy(seed, flapFrames, maxFrame) {
  const state = createState(seed);
  state.phase = "playing";
  const frames = [...flapFrames].sort((left, right) => left - right);
  let flapCursor = 0;
  const cap = Math.max(0, Math.trunc(maxFrame));
  for (let frame = 1; frame <= cap; frame += 1) {
    while (flapCursor < frames.length && frames[flapCursor] < frame) flapCursor += 1;
    while (flapCursor < frames.length && frames[flapCursor] === frame) {
      if (isPlaying(state)) state.bird.vy = FLAP_VELOCITY;
      flapCursor += 1;
    }
    stepFrame(state);
    if (isCrashed(state)) break;
  }
  return {
    pipesPassed: state.score,
    crashed: isCrashed(state),
    framesRun: state.frame
  };
}
function flappyAnswer(pipesPassed, flapFrames) {
  return `flappy:${pipesPassed}:${[...flapFrames].sort((left, right) => left - right).join(",")}`;
}
export {
  BIRD_HEIGHT,
  BIRD_WIDTH,
  BIRD_X,
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  FRAME_MS,
  GROUND_HEIGHT,
  PIPE_WIDTH,
  SeededRandom,
  flappyAnswer,
  replayFlappy,
  seedString
};
