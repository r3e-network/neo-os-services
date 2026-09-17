// Generic session-host flows — start -> step -> finalize through the SAME
// host for every engine (no per-game host code). Covers, generically:
//   - start returns commitment + engine_hash + session_token + reveal_policy,
//     and is idempotent (repeated start = identical commitment/token/view),
//   - a happy-path run per engine reaches a (test-overridden) target and
//     finalize returns the 79-byte result codec + a decoded score,
//   - the finalize result_bytes decode to the same fields the response reports,
//   - identity/token/seq/time-window rejection lanes,
//   - the engine_hash gate rejects a wrong hash at start.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  __resetSecretsProviderStateForTests,
  __setSecretsProviderForTests,
  deriveNeoN3PrivateKeyHex,
} from '../platform/nitro-signer.js';
import {
  __resetCustodyTransportForTests,
  __setCustodyTransportForTests,
} from '../platform/custody.js';
import {
  GAME_SECRET_KEY_ROLE,
  __resetGameSessionsForTests,
  __setGameClockForTests,
  __setGameTargetForTests,
  handleSessionFinalize,
  handleSessionStart,
  handleSessionStep,
} from './session.js';
import { registryManifest, resolveEngine } from './registry.js';
import { seedString, SeededRandom, FRAME_MS } from './engines/flappy.js';
import { dealSnake, stepSnake } from './engines/snake.adapter.js';
import { generatePattern, ringOf, AIM_CONFIG } from './engines/aim.js';
import { colorSequence } from './engines/color.js';
import { newBoard } from './engines/merge.adapter.js';
import { dealPuzzle } from './engines/sudoku.js';

const MANIFEST = registryManifest();

function idOf(appId, difficulty = 0, overrides = {}) {
  return {
    app_id: appId,
    engine_hash: MANIFEST[appId],
    network: 'testnet',
    contract_hash: '0x00112233445566778899aabbccddeeff00112233',
    game_id: '42',
    player: '0x0102030405060708090a0b0c0d0e0f1011121314',
    difficulty,
    ...overrides,
  };
}

let fakeNow = 0;
const originalWorkerKeyId = process.env.SIGNER_ROLE_WORKER_KEY_ID;

test.before(() => {
  process.env.SIGNER_ROLE_WORKER_KEY_ID = 'test-worker-key';
  __setSecretsProviderForTests(() => ({
    getSecret: async () => Buffer.alloc(48, 7).toString('base64'),
  }));
  __setCustodyTransportForTests(async (method) =>
    method === 'GET'
      ? {
          key_id: 'test-worker-key',
          network: 'testnet',
          network_magic: 894710606,
          public_key: `02${'22'.repeat(32)}`,
          address: 'NTestWorkerCustodyAddress',
          script_hash: `0x${'33'.repeat(20)}`,
          signing_enabled: true,
        }
      : {
          allowed: true,
          signature: '11'.repeat(64),
          public_key: `02${'22'.repeat(32)}`,
          address: 'NTestWorkerCustodyAddress',
          script_hash: `0x${'33'.repeat(20)}`,
        }
  );
});
test.after(() => {
  if (originalWorkerKeyId === undefined) {
    delete process.env.SIGNER_ROLE_WORKER_KEY_ID;
  } else {
    process.env.SIGNER_ROLE_WORKER_KEY_ID = originalWorkerKeyId;
  }
  __resetCustodyTransportForTests();
  __resetSecretsProviderStateForTests();
});
test.beforeEach(() => {
  fakeNow = 1_000_000;
  __setGameClockForTests(() => fakeNow);
  __resetGameSessionsForTests();
});
test.afterEach(() => {
  __setGameClockForTests(null);
  for (const appId of Object.keys(MANIFEST)) __setGameTargetForTests(appId, null);
  __resetGameSessionsForTests();
});

function canonicalOf(id) {
  return `${id.app_id}|${id.network}|${id.contract_hash}|${id.game_id}|${id.player}|${id.difficulty}`;
}
async function problemSecretOf(id) {
  const rootHex = await deriveNeoN3PrivateKeyHex(GAME_SECRET_KEY_ROLE);
  return createHmac('sha256', Buffer.from(rootHex, 'hex')).update(canonicalOf(id), 'utf8').digest();
}
async function body(responsePromise, expectedStatus) {
  const response = await responsePromise;
  const parsed = await response.json();
  if (expectedStatus !== undefined) {
    assert.equal(response.status, expectedStatus, JSON.stringify(parsed));
  }
  return parsed;
}

// Decode the finalize result codec and assert it matches the response fields.
function assertResultCodec(id, fin) {
  const bytes = Buffer.from(fin.result_bytes_base64, 'base64');
  assert.equal(bytes.length, 79);
  assert.equal(bytes[0], 0x02);
  assert.equal(bytes.slice(1, 33).toString('hex'), fin.problem_hash);
  assert.equal(bytes.slice(33, 65).toString('hex'), fin.answer_hash);
  assert.equal(Number(bytes.readBigUInt64BE(65)), fin.elapsed_ms);
  assert.equal(bytes[73], fin.undos);
  assert.equal(bytes.readUInt32BE(74), fin.score);
  assert.equal(bytes[78], id.difficulty);
  assert.equal(fin.callback_encoding, 'game_result_v1');
}

// ── Generic start invariants (every engine) ──────────────────────────────────

for (const appId of Object.keys(MANIFEST)) {
  test(`start: ${appId} returns commitment + engine_hash + token, idempotently`, async () => {
    const id = idOf(appId);
    const start = await body(handleSessionStart(id), 200);
    assert.match(start.commitment, /^[0-9a-f]{64}$/);
    assert.match(start.session_token, /^[0-9a-f]{64}$/);
    assert.equal(start.config.engine_hash, MANIFEST[appId]);
    assert.equal(start.config.app_id, appId);
    assert.equal(typeof start.config.reveal_policy, 'string');
    assert.equal(start.config.max_undos, resolveEngine(appId).descriptor.maxUndos);
    assert.ok(start.config.limit_ms > start.config.min_solve_ms);
    assert.deepEqual(start.current_view, start.view);
    assert.equal(start.op_count, 0);

    const again = await body(handleSessionStart(id), 200);
    assert.equal(again.commitment, start.commitment);
    assert.equal(again.session_token, start.session_token);
    assert.deepEqual(again.view, start.view);
  });
}

test('sheep: repeated start exposes the cached authoritative tray and op count', async () => {
  const id = idOf('miniapp-sheep-solitaire');
  const start = await body(handleSessionStart(id), 200);
  const card = start.view.cards.find((item) => item.exposed && !item.picked);
  const step = await body(
    handleSessionStep({
      ...id,
      session_token: start.session_token,
      seq: 0,
      op: { type: 'pick', cardId: card.id },
    }),
    200
  );
  const again = await body(handleSessionStart(id), 200);

  assert.deepEqual(again.view, start.view);
  assert.deepEqual(again.current_view.slots, step.slots);
  assert.equal(again.current_view.slots.length, 1);
  assert.equal(again.op_count, 1);
});

test('start: a wrong engine_hash is rejected by the whitelist gate', async () => {
  const rejected = await body(
    handleSessionStart(idOf('miniapp-sudoku', 0, { engine_hash: 'f'.repeat(64) })),
    400
  );
  assert.match(rejected.error, /engine_hash mismatch/);
});

test('start: an unregistered app_id is rejected', async () => {
  const rejected = await body(
    handleSessionStart(idOf('miniapp-sudoku', 0, { app_id: 'miniapp-chess' })),
    400
  );
  assert.match(rejected.error, /app_id must be one of/);
});

// ── Sudoku happy path (solution never leaves the enclave) ────────────────────

test('sudoku: start reveals only clues; correct solution finalizes with the codec', async () => {
  const id = idOf('miniapp-sudoku');
  const start = await body(handleSessionStart(id), 200);
  assert.match(start.view.clues, /^[0-9]{81}$/);
  assert.equal(start.view.solution, undefined);

  const dealt = dealPuzzle(await problemSecretOf(id), id.difficulty);
  assert.equal(start.view.clues, dealt.puzzle);

  let seq = 0;
  for (let cell = 0; cell < 81; cell += 1) {
    if (dealt.puzzle.charAt(cell) !== '0') continue;
    fakeNow += 150;
    await body(
      handleSessionStep({
        ...id,
        session_token: start.session_token,
        seq,
        op: { type: 'place', cell, digit: Number(dealt.solution.charAt(cell)) },
      }),
      200
    );
    seq += 1;
  }

  fakeNow = 1_000_000 + 95_000;
  const fin = await body(
    handleSessionFinalize({ ...id, session_token: start.session_token, answer: dealt.solution }),
    200
  );
  assert.equal(fin.problem_hash, start.commitment);
  assert.equal(fin.score, 1);
  assert.equal(fin.undos, 0);
  assertResultCodec(id, fin);
});

test('sudoku: undo trims the last placement and the 4th undo is rejected', async () => {
  const id = idOf('miniapp-sudoku');
  const start = await body(handleSessionStart(id), 200);
  const dealt = dealPuzzle(await problemSecretOf(id), id.difficulty);
  const holes = [];
  for (let cell = 0; cell < 81 && holes.length < 4; cell += 1) {
    if (dealt.puzzle.charAt(cell) === '0') holes.push(cell);
  }
  let seq = 0;
  for (const cell of holes) {
    fakeNow += 200;
    await body(
      handleSessionStep({
        ...id,
        session_token: start.session_token,
        seq,
        op: { type: 'place', cell, digit: Number(dealt.solution.charAt(cell)) },
      }),
      200
    );
    seq += 1;
  }
  for (let i = 1; i <= 3; i += 1) {
    fakeNow += 200;
    const undone = await body(
      handleSessionStep({ ...id, session_token: start.session_token, seq, op: { type: 'undo' } }),
      200
    );
    assert.equal(undone.undos, i);
    seq += 1;
  }
  fakeNow += 200;
  const rejected = await body(
    handleSessionStep({ ...id, session_token: start.session_token, seq, op: { type: 'undo' } }),
    409
  );
  assert.match(rejected.error, /undo limit/);
});

// ── 2048 happy path with a test-scoped exp target ────────────────────────────

test('2048: reaches a test-scoped target and finalizes with the codec', async () => {
  __setGameTargetForTests('miniapp-game-2048', [3, 3, 3]);
  const id = idOf('miniapp-game-2048');
  const start = await body(handleSessionStart(id), 200);
  assert.equal(start.config.target_exp, 3);
  assert.equal(start.view.board.length, 16);

  let seq = 0;
  let maxExp = Math.max(...start.view.board);
  let guard = 0;
  while (maxExp < 3 && guard < 600) {
    let advanced = false;
    for (let dir = 0; dir < 4 && !advanced; dir += 1) {
      fakeNow += 150;
      guard += 1;
      const moved = await body(
        handleSessionStep({
          ...id,
          session_token: start.session_token,
          seq,
          op: { type: 'move', dir },
        }),
        200
      );
      seq += 1;
      if (moved.ok) {
        advanced = true;
        maxExp = Math.max(maxExp, ...moved.board);
      }
    }
    assert.ok(advanced, 'board locked before target');
  }
  fakeNow = Math.max(fakeNow, 1_000_000 + 65_000);
  const fin = await body(handleSessionFinalize({ ...id, session_token: start.session_token }), 200);
  assert.equal(fin.problem_hash, start.commitment);
  assert.ok(fin.score >= 3);
  assertResultCodec(id, fin);
});

// ── Flappy (reflex, seed reveal) ─────────────────────────────────────────────

test('flappy: seed-only start; replayed flaps finalize with pipes_passed', async () => {
  const id = idOf('miniapp-flappy-dash');
  const start = await body(handleSessionStart(id), 200);
  assert.match(start.view.seed, /^[0-9a-f]{64}$/);
  assert.equal(start.config.target_pipes, 5);

  const seed = seedString(await problemSecretOf(id));
  const plan = autopilotFlaps(seed, 1500);
  assert.ok(plan.score >= 5);

  let seq = 0;
  for (const frame of plan.flapFrames) {
    fakeNow = 1_000_000 + Math.round(frame * FRAME_MS);
    await body(
      handleSessionStep({ ...id, session_token: start.session_token, seq, op: { type: 'flap' } }),
      200
    );
    seq += 1;
  }
  fakeNow = 1_000_000 + 25_000;
  const fin = await body(handleSessionFinalize({ ...id, session_token: start.session_token }), 200);
  assert.ok(fin.pipes_passed >= 5);
  assert.equal(fin.score, fin.pipes_passed);
  assert.equal(fin.answer_hash, fin.state_hash);
  assertResultCodec(id, fin);
});

// ── Snake (clues reveal) ─────────────────────────────────────────────────────

test('snake: clues reveal; moves grow the snake and finalize on length', async () => {
  const id = idOf('miniapp-snake-bounty');
  const start = await body(handleSessionStart(id), 200);
  const clues = JSON.parse(start.view.clues);
  assert.equal(clues.body.length, 3);
  assert.equal(start.config.target_length, 10);

  const plan = greedySnake(await problemSecretOf(id), 400, 10);
  assert.ok(plan.length >= 10);
  let seq = 0;
  for (const dir of plan.dirs) {
    fakeNow += 200;
    await body(
      handleSessionStep({
        ...id,
        session_token: start.session_token,
        seq,
        op: { type: 'move', dir },
      }),
      200
    );
    seq += 1;
  }
  fakeNow = Math.max(fakeNow, 1_000_000 + 25_000);
  const fin = await body(handleSessionFinalize({ ...id, session_token: start.session_token }), 200);
  assert.ok(fin.score >= 10);
  assertResultCodec(id, fin);
});

// ── Aim (reflex, enclave scores its own tick) ────────────────────────────────

test('aim: pattern reveal; accuracy aims finalize on rings_hit', async () => {
  const id = idOf('miniapp-aim-master');
  const start = await body(handleSessionStart(id), 200);
  assert.match(start.view.pattern, /^[0-9]+(,[0-9]+)*$/);
  assert.equal(start.config.target_accuracy, 3);

  const pattern = generatePattern(await problemSecretOf(id));
  const aims = scheduleRounds(pattern, 4, 2000, (ring) => ring <= 2);
  assert.ok(aims.length >= 3);
  let seq = 0;
  for (const aim of aims) {
    fakeNow = 1_000_000 + aim.elapsedMs;
    await body(
      handleSessionStep({
        ...id,
        session_token: start.session_token,
        seq,
        op: { type: 'aim', position: pattern[aim.tick] },
      }),
      200
    );
    seq += 1;
  }
  fakeNow = 1_000_000 + 15_000;
  const fin = await body(handleSessionFinalize({ ...id, session_token: start.session_token }), 200);
  assert.ok(fin.rings_hit >= 3);
  assertResultCodec(id, fin);
});

// ── Color (reveal-per-round) ─────────────────────────────────────────────────

test('color: empty start sequence; colours arrive per-round; finalize on seq', async () => {
  const id = idOf('miniapp-color-clash');
  const start = await body(handleSessionStart(id), 200);
  assert.equal(start.view.sequence, '');
  assert.equal(start.config.target_seq, 8);

  const seq = colorSequence(await problemSecretOf(id));
  let moveSeq = 0;
  const revealed = [seq.charCodeAt(0) - 48];
  for (let round = 1; round <= 8; round += 1) {
    assert.equal(revealed.length, round);
    for (let i = 0; i < round; i += 1) {
      fakeNow += 200;
      const res = await body(
        handleSessionStep({
          ...id,
          session_token: start.session_token,
          seq: moveSeq,
          op: { type: 'press', color: seq.charCodeAt(i) - 48 },
        }),
        200
      );
      moveSeq += 1;
      if (res.round_complete && res.reveal !== undefined) {
        assert.equal(res.reveal, seq.charCodeAt(round) - 48);
        revealed.push(res.reveal);
      }
    }
  }
  fakeNow = Math.max(fakeNow, 1_000_000 + 20_000);
  const fin = await body(handleSessionFinalize({ ...id, session_token: start.session_token }), 200);
  assert.equal(fin.score, 8);
  assertResultCodec(id, fin);
});

// ── Merge (spawn reveal) ─────────────────────────────────────────────────────

test('merge: board reveal; a merge reveals the next spawn and finalizes on tile', async () => {
  const id = idOf('miniapp-merge-kingdom');
  __setGameTargetForTests('miniapp-merge-kingdom', [4, 4, 4]);
  const start = await body(handleSessionStart(id), 200);
  assert.equal(start.view.board.length, 4);
  assert.equal(start.config.target_tile, 4);

  const initial = newBoard(await problemSecretOf(id)).board;
  const pair = firstEqualPair(initial);
  assert.ok(pair);
  fakeNow += 300;
  const moved = await body(
    handleSessionStep({
      ...id,
      session_token: start.session_token,
      seq: 0,
      op: { type: 'move', from: pair.from, to: pair.to },
    }),
    200
  );
  assert.equal(moved.merged, true);
  assert.ok(moved.spawn && moved.spawn.value >= 2);
  fakeNow = 1_000_000 + 35_000;
  const fin = await body(handleSessionFinalize({ ...id, session_token: start.session_token }), 200);
  assert.equal(fin.score, pair.value * 2);
  assertResultCodec(id, fin);
});

// ── Pet (deterministic deltas + action spacing) ──────────────────────────────

test('pet: care actions finalize on peak happiness', async () => {
  const id = idOf('miniapp-pet-potion');
  const start = await body(handleSessionStart(id), 200);
  assert.equal(start.view.happiness, 20);
  assert.equal(start.config.target_happiness, 50);

  const cadence = ['feed', 'play', 'rest', 'pet'];
  let seq = 0;
  let reached = false;
  for (let i = 0; i < 40 && !reached; i += 1) {
    fakeNow += 1600;
    const res = await body(
      handleSessionStep({
        ...id,
        session_token: start.session_token,
        seq,
        op: { type: cadence[i % 4] },
      }),
      200
    );
    seq += 1;
    if (res.view.happiness >= 50) reached = true;
  }
  assert.ok(reached);
  fakeNow = Math.max(fakeNow, 1_000_000 + 35_000);
  const fin = await body(handleSessionFinalize({ ...id, session_token: start.session_token }), 200);
  assert.ok(fin.score >= 50);
  assertResultCodec(id, fin);
});

test('pet: bursting care actions under the spacing floor is rejected', async () => {
  const id = idOf('miniapp-pet-potion');
  const start = await body(handleSessionStart(id), 200);
  fakeNow += 1600;
  await body(
    handleSessionStep({ ...id, session_token: start.session_token, seq: 0, op: { type: 'feed' } }),
    200
  );
  fakeNow += 100;
  const rejected = await body(
    handleSessionStep({ ...id, session_token: start.session_token, seq: 1, op: { type: 'play' } }),
    429
  );
  assert.match(rejected.error, /spaced/);
});

// ── Rejection lanes (generic host) ───────────────────────────────────────────

test('rejection lanes: identity, token, seq, time-window, unknown session', async () => {
  await body(handleSessionStart(idOf('miniapp-sudoku', 5)), 400); // bad difficulty
  await body(handleSessionStart(idOf('miniapp-sudoku', 0, { player: '0x1234' })), 400);
  await body(handleSessionStart(idOf('miniapp-sudoku', 0, { game_id: 'abc' })), 400);
  await body(handleSessionStart(idOf('miniapp-sudoku', 0, { network: 'devnet' })), 400);

  const id = idOf('miniapp-sudoku');
  const start = await body(handleSessionStart(id), 200);
  const dealt = dealPuzzle(await problemSecretOf(id), id.difficulty);
  const firstHole = dealt.puzzle.indexOf('0');

  // Bad token on step + finalize.
  await body(
    handleSessionStep({
      ...id,
      session_token: 'f'.repeat(64),
      seq: 0,
      op: { type: 'place', cell: firstHole, digit: 1 },
    }),
    401
  );
  await body(handleSessionFinalize({ ...id, session_token: 'f'.repeat(64) }), 401);

  // Stale seq.
  fakeNow += 200;
  await body(
    handleSessionStep({
      ...id,
      session_token: start.session_token,
      seq: 5,
      op: { type: 'place', cell: firstHole, digit: Number(dealt.solution.charAt(firstHole)) },
    }),
    200
  );
  fakeNow += 200;
  const stale = await body(
    handleSessionStep({
      ...id,
      session_token: start.session_token,
      seq: 5,
      op: { type: 'place', cell: firstHole, digit: 1 },
    }),
    409
  );
  assert.match(stale.error, /stale seq/);

  // Too fast, then wrong answer inside the window.
  fakeNow = 1_000_000 + 10_000;
  const fast = await body(
    handleSessionFinalize({ ...id, session_token: start.session_token, answer: dealt.solution }),
    403
  );
  assert.match(fast.error, /too fast/);
  fakeNow = 1_000_000 + 95_000;
  const flipped = (dealt.solution.charAt(0) === '1' ? '2' : '1') + dealt.solution.slice(1);
  const wrong = await body(
    handleSessionFinalize({ ...id, session_token: start.session_token, answer: flipped }),
    403
  );
  assert.match(wrong.error, /answer does not match|incorrect/);

  // Unknown session (post-restart, no replay) cannot finalize.
  __resetGameSessionsForTests();
  await body(
    handleSessionFinalize({ ...id, session_token: start.session_token, answer: dealt.solution }),
    404
  );
});

test('session recovery: a cache-miss step rebuilds from the replayed log', async () => {
  const id = idOf('miniapp-sudoku');
  const start = await body(handleSessionStart(id), 200);
  const dealt = dealPuzzle(await problemSecretOf(id), id.difficulty);
  const holes = [];
  for (let cell = 0; cell < 81; cell += 1) if (dealt.puzzle.charAt(cell) === '0') holes.push(cell);

  const priorOps = [];
  let replayProof = start.replay_proof;
  for (let i = 0; i < 3; i += 1) {
    fakeNow += 200;
    const op = { type: 'place', cell: holes[i], digit: Number(dealt.solution.charAt(holes[i])) };
    const stepped = await body(
      handleSessionStep({ ...id, session_token: start.session_token, seq: i, op }),
      200
    );
    replayProof = stepped.replay_proof;
    priorOps.push(op);
  }
  __resetGameSessionsForTests();
  fakeNow += 200;
  const resumed = await body(
    handleSessionStep({
      ...id,
      session_token: start.session_token,
      seq: 3,
      replay: priorOps,
      replay_proof: replayProof,
      op: { type: 'place', cell: holes[3], digit: Number(dealt.solution.charAt(holes[3])) },
    }),
    200
  );
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.op_count, 4);

  // Commitment stays stable across the rebuild.
  const again = await body(handleSessionStart(id), 200);
  assert.equal(again.commitment, start.commitment);
});

test('session recovery rejects a client-forged replay without an enclave proof', async () => {
  const id = idOf('miniapp-sudoku');
  const start = await body(handleSessionStart(id), 200);
  __resetGameSessionsForTests();

  const rejected = await body(
    handleSessionStep({
      ...id,
      session_token: start.session_token,
      seq: 1,
      replay: [{ type: 'place', cell: 0, digit: 9 }],
      op: { type: 'place', cell: 1, digit: 9 },
    }),
    401
  );
  assert.match(rejected.error, /authenticated replay proof/);
});

// ── Helpers (ported from the deterministic engine test harness) ──────────────

function scheduleRounds(pattern, count, gapMs, predicate) {
  const rounds = [];
  let elapsed = gapMs;
  const ceiling = 12_000;
  while (rounds.length < count && elapsed <= ceiling) {
    const tick = Math.round(elapsed / AIM_CONFIG.tickMs) % pattern.length;
    if (predicate(ringOf(pattern[tick]))) {
      rounds.push({ elapsedMs: elapsed, tick });
      elapsed += gapMs;
    } else {
      elapsed += AIM_CONFIG.tickMs;
    }
  }
  return rounds;
}

function firstEqualPair(board) {
  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      const v = board[r * 4 + c];
      if (!v) continue;
      for (const [nr, nc] of [
        [r + 1, c],
        [r, c + 1],
      ]) {
        if (nr > 3 || nc > 3) continue;
        if (board[nr * 4 + nc] === v) {
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
  const FLAP_COOLDOWN = 8;
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
