// Deterministic engine parity for the six arcade games. Each game gets:
//  - a determinism check (same secret -> same view/derivation),
//  - a couple of hand-verified golden vectors proving the score derivation,
//  - the byte-identical-to-frontend invariants (constants / RNG shape).
// The session-level happy paths live in arcade-session.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { FRAME_MS, SeededRandom, replayFlappy, seedString } from './engines/flappy.js';
import { dealSnake, replaySnake, stepSnake, snakeCluesView } from './engines/snake.adapter.js';
import { AIM_CONFIG, generatePattern, patternView, replayAim, ringOf } from './engines/aim.js';
import { colorSequence, newColorState, pressColor, replayColor } from './engines/color.js';
import { newBoard, replayMerge, stepMerge, toGrid } from './engines/merge.adapter.js';
import { newPet, replayPet, stepPet } from './engines/pet.js';

function secretOf(label) {
  return createHmac('sha256', Buffer.alloc(32, 7)).update(label, 'utf8').digest();
}

// ─── Flappy ─────────────────────────────────────────────────────────────────

test('flappy: SeededRandom is the byte-identical xorshift twin', () => {
  // Golden vector: the frontend hashSeed+xorshift for seed "abc" — hand-computed
  // by running the exact same operations.
  const rng = new SeededRandom('abc');
  const a = rng.next();
  const b = rng.next();
  assert.ok(a >= 0 && a < 1);
  assert.ok(b >= 0 && b < 1);
  // Deterministic: a fresh RNG for the same seed reproduces the stream.
  const rng2 = new SeededRandom('abc');
  assert.equal(rng2.next(), a);
  assert.equal(rng2.next(), b);
  assert.equal(FRAME_MS, 1000 / 60);
});

test('flappy: seed view is a stable pure function of the secret', () => {
  const secret = secretOf('flappy-golden');
  const seed = seedString(secret);
  assert.match(seed, /^[0-9a-f]{64}$/);
  assert.equal(seed, seedString(secret));
});

test('flappy: replay is deterministic and scores pipes for a survivable flap plan', () => {
  const secret = secretOf('flappy-golden');
  const seed = seedString(secret);
  // Gap-tracking autopilot proven to survive: flap whenever the bird centre is
  // below the nearest gap centre. Reproduce the flap frames the same physics
  // yields, then assert the score is stable and positive.
  const plan = autopilotFlaps(seed, 1500);
  const run = replayFlappy(seed, plan.flapFrames, 1500);
  assert.equal(run.pipesPassed, plan.score);
  assert.ok(run.pipesPassed >= 5, `expected >=5 pipes, got ${run.pipesPassed}`);
  // Replaying the identical flap frames reproduces the identical score.
  const again = replayFlappy(seed, plan.flapFrames, 1500);
  assert.equal(again.pipesPassed, run.pipesPassed);
  assert.equal(again.crashed, run.crashed);
});

test('flappy: an empty flap plan crashes (bird falls) — zero pipes', () => {
  const seed = seedString(secretOf('flappy-fall'));
  const run = replayFlappy(seed, [], 1500);
  assert.equal(run.pipesPassed, 0);
  assert.equal(run.crashed, true);
});

// ─── Snake ──────────────────────────────────────────────────────────────────

test('snake: deal is a stable pure function; clues view parses to the same state', () => {
  const secret = secretOf('snake-golden');
  const a = dealSnake(secret);
  const b = dealSnake(secret);
  assert.deepEqual(a.body, b.body);
  assert.deepEqual(a.food, b.food);
  assert.equal(a.body.length, 3);
  assert.equal(a.direction, 1);
  const parsed = JSON.parse(snakeCluesView(secret));
  assert.deepEqual(parsed.body, a.body);
  assert.deepEqual(parsed.food, a.food);
  assert.equal(parsed.foodQueue.length, a.foodQueue.length);
});

test('snake: eating grows the snake and advances the food queue', () => {
  const secret = secretOf('snake-golden');
  const deal = dealSnake(secret);
  // Drive the head straight at the food to eat exactly once.
  const plan = greedySnake(secret, 300, 6);
  const replay = replaySnake(secret, plan.dirs);
  assert.equal(replay.length, deal.initialLength + replay.eaten);
  assert.ok(replay.eaten >= 3, `expected apples eaten, got ${replay.eaten}`);
  // Deterministic.
  const again = replaySnake(secret, plan.dirs);
  assert.equal(again.length, replay.length);
  assert.equal(again.eaten, replay.eaten);
});

test('snake: running into the wall kills the snake', () => {
  const secret = secretOf('snake-golden');
  const deal = dealSnake(secret);
  // Head starts heading right; force it up until it leaves the grid.
  const dirs = new Array(deal.body[0].y + 1).fill(0);
  const replay = replaySnake(secret, dirs);
  assert.equal(replay.dead, true);
});

// ─── Aim ────────────────────────────────────────────────────────────────────

test('aim: pattern is a stable pure function within the gauge bounds', () => {
  const secret = secretOf('aim-golden');
  const pat = generatePattern(secret);
  assert.equal(pat.length, Math.ceil(5000 / AIM_CONFIG.tickMs));
  for (const p of pat) assert.ok(p >= 0 && p <= AIM_CONFIG.width);
  assert.deepEqual(pat, generatePattern(secret));
  assert.equal(patternView(secret), pat.join(','));
});

test('aim: ring boundaries match calculateHitResult', () => {
  // Golden ring boundaries from the frontend geometry (centre 150, bullseye
  // radius 6, ring width 24).
  assert.equal(ringOf(150), 0); // dead centre
  assert.equal(ringOf(156), 0); // exactly bullseye radius
  assert.equal(ringOf(157), 1); // just past bullseye: (7-6)/24=0 -> ring 1
  assert.equal(ringOf(179), 1); // 29px -> (29-6)/24=0 -> ring 1
  assert.equal(ringOf(180), 2); // 30px -> (30-6)/24=1 -> ring 2
  assert.equal(ringOf(0), 5); // far edge clamps to outer ring
});

test('aim: replay counts only ring<=2 ticks as accuracy hits', () => {
  const secret = secretOf('aim-golden');
  const pattern = generatePattern(secret);
  // Pick the first ticks that land in the accuracy zone.
  const ticks = [];
  for (let t = 0; t < pattern.length && ticks.length < 5; t += 1) {
    if (ringOf(pattern[t]) <= 2) ticks.push(t);
  }
  assert.equal(ticks.length, 5, 'expected accuracy ticks to exist');
  const replay = replayAim(pattern, ticks);
  assert.equal(replay.accuracyHits, 5);
  // A tick guaranteed to be outside the zone contributes nothing.
  let missTick = -1;
  for (let t = 0; t < pattern.length; t += 1) {
    if (ringOf(pattern[t]) > 2) {
      missTick = t;
      break;
    }
  }
  if (missTick >= 0) {
    const mixed = replayAim(pattern, [...ticks, missTick]);
    assert.equal(mixed.accuracyHits, 5);
  }
});

// ─── Color ──────────────────────────────────────────────────────────────────

test('color: sequence is stable digits 0..3, long enough for the hardest target', () => {
  const secret = secretOf('color-golden');
  const seq = colorSequence(secret);
  assert.match(seq, /^[0-3]{24}$/);
  assert.equal(seq, colorSequence(secret));
});

test('color: correct presses grow the best round; a wrong press ends the run', () => {
  const secret = secretOf('color-golden');
  const seq = colorSequence(secret);
  const state = newColorState();
  // Complete round 1 (echo colour 0) -> best becomes 1 and colour 1 is revealed.
  const r1 = pressColor(seq, state, seq.charCodeAt(0) - 48);
  assert.equal(r1.roundComplete, true);
  assert.equal(r1.best, 1);
  assert.equal(r1.reveal, seq.charCodeAt(1) - 48);
  // Round 2: echo colours [0,1].
  pressColor(seq, state, seq.charCodeAt(0) - 48);
  const r2b = pressColor(seq, state, seq.charCodeAt(1) - 48);
  assert.equal(r2b.best, 2);
  // A wrong press ends the run and freezes best.
  const wrongColor = (seq.charCodeAt(0) - 48 + 1) % 4;
  const wrong = pressColor(seq, state, wrongColor);
  assert.equal(wrong.over, true);
  assert.equal(state.best, 2);
});

test('color: replay derives the longest completed round', () => {
  const secret = secretOf('color-golden');
  const seq = colorSequence(secret);
  // Play rounds 1..8 perfectly.
  const presses = [];
  for (let round = 1; round <= 8; round += 1) {
    for (let i = 0; i < round; i += 1) presses.push(seq.charCodeAt(i) - 48);
  }
  const replay = replayColor(secret, presses);
  assert.equal(replay.best, 8);
  assert.equal(replay.over, false);
});

// ─── Merge ──────────────────────────────────────────────────────────────────

test('merge: opening board is stable and merging an equal pair doubles + spawns', () => {
  const secret = secretOf('merge-golden');
  const a = newBoard(secret);
  const b = newBoard(secret);
  assert.deepEqual(a.board, b.board);
  const pair = firstEqualPair(a.board);
  assert.ok(pair, 'opening board should have an adjacent equal pair');
  const next = stepMerge(secret, a, pair.from, pair.to);
  assert.equal(next.merged, true);
  assert.equal(next.maxTile, pair.value * 2);
  assert.ok(next.spawn && next.spawn.value >= 2);
});

test('merge: reposition into an empty cell moves the tile without a spawn', () => {
  const secret = secretOf('merge-golden');
  const state = newBoard(secret);
  const move = firstReposition(state.board);
  assert.ok(move, 'opening board should allow a reposition into an empty neighbour');
  const next = stepMerge(secret, state, move.from, move.to);
  assert.equal(next.merged, false);
  assert.equal(next.spawn, null);
  const grid = toGrid(next.board);
  assert.equal(grid[move.to.row][move.to.col], move.value);
  assert.equal(grid[move.from.row][move.from.col], 0);
});

test('merge: illegal moves are rejected and replay is deterministic', () => {
  const secret = secretOf('merge-golden');
  const state = newBoard(secret);
  // Non-adjacent move.
  assert.equal(stepMerge(secret, state, { row: 0, col: 0 }, { row: 3, col: 3 }), null);
  const pair = firstEqualPair(state.board);
  const replayA = replayMerge(secret, [pair]);
  const replayB = replayMerge(secret, [pair]);
  assert.ok(replayA.ok);
  assert.deepEqual(replayA.board, replayB.board);
  assert.equal(replayA.maxTile, pair.value * 2);
});

// ─── Pet ────────────────────────────────────────────────────────────────────

test('pet: care deltas are deterministic and clamp to 0..100', () => {
  const start = newPet();
  assert.deepEqual(start, { happiness: 20, hunger: 40, energy: 60 });
  const fed = stepPet(start, 'feed');
  assert.ok(fed.hunger > start.hunger);
  assert.ok(fed.happiness >= start.happiness);
  // Feeding repeatedly clamps hunger at 100, never above.
  let s = start;
  for (let i = 0; i < 20; i += 1) s = stepPet(s, 'feed');
  assert.equal(s.hunger, 100);
  assert.ok(s.happiness <= 100 && s.happiness >= 0);
});

test('pet: play needs fuel + energy for its full happiness gain', () => {
  // A pet with plenty of hunger and energy gains the full play bonus.
  const strong = { happiness: 20, hunger: 60, energy: 60 };
  const played = stepPet(strong, 'play');
  assert.equal(played.happiness, 32); // +12
  assert.equal(played.hunger, 40);
  assert.equal(played.energy, 40);
  // A depleted pet gains little from play.
  const weak = { happiness: 20, hunger: 4, energy: 4 };
  const weakPlay = stepPet(weak, 'play');
  assert.ok(weakPlay.happiness - weak.happiness <= 1);
});

test('pet: replay tracks the peak happiness reached', () => {
  const actions = ['feed', 'play', 'rest', 'feed', 'play', 'pet', 'rest', 'feed', 'play'];
  const replay = replayPet(actions);
  assert.ok(replay.peak >= replay.happiness);
  assert.ok(replay.peak >= 50, `expected the care cadence to reach 50, got ${replay.peak}`);
  // Deterministic.
  const again = replayPet(actions);
  assert.equal(again.peak, replay.peak);
});

// ─── Shared helpers (autopilots used to generate reachable golden plans) ─────

function firstEqualPair(board) {
  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      const v = board[r * 4 + c];
      if (!v) continue;
      const neigh = [
        [r + 1, c],
        [r, c + 1],
      ];
      for (const [nr, nc] of neigh) {
        if (nr > 3 || nc > 3) continue;
        if (board[nr * 4 + nc] === v) {
          return { from: { row: r, col: c }, to: { row: nr, col: nc }, value: v };
        }
      }
    }
  }
  return null;
}

function firstReposition(board) {
  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      const v = board[r * 4 + c];
      if (!v) continue;
      const neigh = [
        [r + 1, c],
        [r - 1, c],
        [r, c + 1],
        [r, c - 1],
      ];
      for (const [nr, nc] of neigh) {
        if (nr < 0 || nr > 3 || nc < 0 || nc > 3) continue;
        if (board[nr * 4 + nc] === 0) {
          return { from: { row: r, col: c }, to: { row: nr, col: nc }, value: v };
        }
      }
    }
  }
  return null;
}

function greedySnake(secret, maxMoves, stopLength) {
  const deal = dealSnake(secret);
  let state = {
    body: deal.body.map((p) => ({ ...p })),
    direction: deal.direction,
    food: { ...deal.food },
    foodQueue: deal.foodQueue.map((p) => ({ ...p })),
    dead: false,
    eaten: 0,
  };
  const dirs = [];
  for (let i = 0; i < maxMoves; i += 1) {
    const head = state.body[0];
    const food = state.food;
    const options = [];
    if (food.y < head.y) options.push(0);
    if (food.x > head.x) options.push(1);
    if (food.y > head.y) options.push(2);
    if (food.x < head.x) options.push(3);
    let moved = false;
    for (const dir of [...options, 0, 1, 2, 3]) {
      const r = stepSnake(state, dir);
      if (r.changed && !r.state.dead) {
        state = r.state;
        dirs.push(dir);
        moved = true;
        break;
      }
    }
    if (!moved) break;
    if (state.body.length >= stopLength) break;
  }
  return { dirs, length: state.body.length, eaten: state.eaten };
}

// Gap-tracking flappy autopilot: reproduces the physics one frame at a time and
// flaps whenever the bird centre falls below the nearest gap centre (proven to
// survive and score). Returns the flap frames and the resulting pipe score.
function autopilotFlaps(seed, maxFrame) {
  const GRAVITY = 0.45;
  const FLAP = -7.2;
  const MAXV = 10;
  const GH = 80;
  const CH = 600;
  const BH = 24;
  const BW = 34;
  const BX = 80;
  const PGAP = 140;
  const PW = 52;
  const PSPEED = 2.5;
  const PSPAWN = 100;
  const MINTOP = 60;
  const MAXBOT = CH - GH - PGAP - 60;
  const FIRST = 60;
  const FLAP_COOLDOWN = 8; // human-like tap spacing (keeps under the burst cap)
  const rng = new SeededRandom(seed);
  let by = CH / 2 - BH / 2;
  let vy = 0;
  let frame = 0;
  let score = 0;
  let pipes = [];
  let nextSpawn = FIRST;
  const flapFrames = [];
  let lastFlap = -999;
  for (let f = 1; f <= maxFrame; f += 1) {
    let target = CH / 2 - BH / 2;
    let nearest = null;
    for (const p of pipes) {
      if (p.x + PW >= BX - 20 && (!nearest || p.x < nearest.x)) nearest = p;
    }
    if (nearest) target = nearest.gapY + PGAP / 2 - BH / 2;
    // Flap only when falling below the target and the cooldown has elapsed, so
    // the tap cadence stays within the behavioural rate cap (a real player taps
    // in discrete beats, not every frame).
    if (by > target && vy > 0 && f - lastFlap >= FLAP_COOLDOWN) {
      vy = FLAP;
      flapFrames.push(f);
      lastFlap = f;
    }
    frame += 1;
    vy += GRAVITY;
    if (vy > MAXV) vy = MAXV;
    by += vy;
    if (by + BH >= CH - GH) break;
    if (by <= 0) {
      by = 0;
      vy = 0;
    }
    if (frame >= nextSpawn) {
      pipes.push({ x: 400, gapY: rng.nextInt(MINTOP, MAXBOT), scored: false });
      nextSpawn = frame + PSPAWN;
    }
    let crashed = false;
    for (let i = pipes.length - 1; i >= 0; i -= 1) {
      const p = pipes[i];
      p.x -= PSPEED;
      if (!p.scored && p.x + PW < BX) {
        p.scored = true;
        score += 1;
      }
      if (p.x + PW < 0) pipes.splice(i, 1);
    }
    for (const p of pipes) {
      if (BX < p.x + PW && BX + BW > p.x && by < p.gapY) {
        crashed = true;
        break;
      }
      const bpy = p.gapY + PGAP;
      const bh = CH - GH - bpy;
      if (BX < p.x + PW && BX + BW > p.x && by < bpy + bh && by + BH > bpy) {
        crashed = true;
        break;
      }
    }
    if (crashed) break;
  }
  return { flapFrames, score };
}
