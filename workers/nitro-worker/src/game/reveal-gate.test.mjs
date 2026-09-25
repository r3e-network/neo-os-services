// Reveal-policy + behavioural-gate coverage, PARAMETERIZED over every registered
// engine (no per-game code in the test either — the expectations come from the
// engine descriptor). Two cross-cutting properties:
//   (a) reveal policy: the start view discloses ONLY what the engine's
//       revealPolicy permits — no future secret leaks at start.
//   (b) behavioural gate: a super-human uniform op burst is rejected at finalize
//       for every engine (with the score target neutralised so the gate is the
//       sole failure), driven by the descriptor's own gate constants.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  __resetSecretsProviderStateForTests,
  __setSecretsProviderForTests,
  deriveNeoN3PrivateKeyHex,
} from '../platform/nitro-signer.js';
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

const MANIFEST = registryManifest();

// A per-iteration op each engine accepts (and RECORDS) many times, so the burst
// gate sees a long timestamped op stream. 2048 no-op moves (board unchanged) are
// not recorded, so cycle its directions to keep every op board-changing.
const BURST_OP = {
  'miniapp-game-2048': (i) => ({ type: 'move', dir: i % 4 }),
  'miniapp-flappy-dash': () => ({ type: 'flap' }),
  'miniapp-snake-bounty': (i) => ({ type: 'move', dir: [1, 2, 3, 0][i % 4] }),
  'miniapp-aim-master': () => ({ type: 'aim', position: 150 }),
};

let fakeNow = 0;
test.before(() => {
  __setSecretsProviderForTests(() => ({
    getSecret: async () => Buffer.alloc(48, 7).toString('base64'),
  }));
});
test.after(() => __resetSecretsProviderStateForTests());
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

function idOf(appId, difficulty = 0) {
  return {
    app_id: appId,
    engine_hash: MANIFEST[appId],
    network: 'testnet',
    contract_hash: '0x00112233445566778899aabbccddeeff00112233',
    game_id: '77',
    player: '0x0102030405060708090a0b0c0d0e0f1011121314',
    player_witness: {
      public_key: `02${'00'.repeat(32)}`,
      signature: '00'.repeat(64),
    },
    difficulty,
  };
}
function canonicalOf(id) {
  return `${id.app_id}|${id.network}|${id.contract_hash}|${id.game_id}|${id.player}|${id.difficulty}`;
}
async function problemSecretOf(id) {
  const rootHex = await deriveNeoN3PrivateKeyHex(GAME_SECRET_KEY_ROLE);
  return createHmac('sha256', Buffer.from(rootHex, 'hex')).update(canonicalOf(id), 'utf8').digest();
}
async function body(p, expected) {
  const r = await p;
  const j = await r.json();
  if (expected !== undefined) assert.equal(r.status, expected, JSON.stringify(j));
  return j;
}

// ── (a) reveal-policy invariants, parameterized ──────────────────────────────

for (const appId of Object.keys(MANIFEST)) {
  test(`reveal policy: ${appId} start view discloses only what its policy permits`, async () => {
    const id = idOf(appId);
    const engine = resolveEngine(appId);
    const start = await body(handleSessionStart(id), 200);
    const policy = engine.descriptor.revealPolicy;
    assert.equal(start.config.reveal_policy, policy);

    switch (policy) {
      case 'per-round':
        // Color: the future sequence is NEVER handed out at start.
        assert.equal(start.view.sequence, '', `${appId} leaked the sequence at start`);
        break;
      case 'seed':
        // Flappy: only an opaque seed, never the pipe layout / future frames.
        assert.match(start.view.seed, /^[0-9a-f]{64}$/);
        assert.equal(start.view.pattern, undefined);
        break;
      case 'clues':
        // Sudoku/Snake: only the clue view (never the solution / full food set).
        assert.equal(start.view.solution, undefined, `${appId} leaked the solution`);
        break;
      case 'per-move':
        // 2048/aim/merge: the start view is the opening state only; no future
        // spawn/pattern-future is disclosed up front.
        assert.equal(start.view.spawn, undefined, `${appId} leaked a spawn at start`);
        break;
      case 'state-only':
        // Pet: only the current stat view (deterministic; nothing to hide).
        assert.ok('happiness' in start.view);
        break;
      default:
        assert.fail(`unknown reveal policy ${policy} for ${appId}`);
    }

    // No engine ever exposes the raw problemSecret or an answer at start.
    assert.equal(start.view.problem_secret, undefined);
    assert.equal(start.view.answer, undefined);
  });
}

// ── (b) behavioural-gate rejection, parameterized over burstable engines ──────

const BURSTABLE = [
  'miniapp-game-2048',
  'miniapp-flappy-dash',
  'miniapp-snake-bounty',
  'miniapp-aim-master',
];

for (const appId of BURSTABLE) {
  test(`behavioural gate: ${appId} rejects a super-human uniform burst at finalize`, async () => {
    const id = idOf(appId);
    // Neutralise the score target so the behavioural gate is the ONLY failure.
    __setGameTargetForTests(appId, [0, 0, 0]);
    const engine = resolveEngine(appId);
    const cap = engine.descriptor.gates.maxBurstOpsPerSec;

    const start = await body(handleSessionStart(id), 200);
    const opFor = BURST_OP[appId];

    // Issue > cap ops inside a single 1-second window (5ms apart) — a rate no
    // human can sustain, so the descriptor-driven gate must reject at finalize.
    let seq = 0;
    for (let i = 0; i < cap + 40; i += 1) {
      fakeNow += 5; // super-human burst — timestamps recorded 5ms apart
      await body(
        handleSessionStep({ ...id, session_token: start.session_token, seq, op: opFor(i) }),
        200
      );
      seq += 1;
    }
    // Finalize INSIDE the engine's own time window so the burst gate — not the
    // min-solve floor or the limit — is the sole failure. Take the midpoint.
    const win = engine.descriptor.timeWindow;
    fakeNow = 1_000_000 + Math.floor((win.minSolveMs[0] + win.limitMs[0]) / 2);
    const rejected = await body(
      handleSessionFinalize({ ...id, session_token: start.session_token }),
      403
    );
    assert.match(rejected.error, /burst/, `${appId} did not trip the burst gate`);
  });
}

// Sudoku's burst gate (uses place ops — needs valid holes/digits).
test('behavioural gate: sudoku rejects a uniform 5ms place burst at finalize', async () => {
  const { dealPuzzle } = await import('./engines/sudoku.js');
  const id = idOf('miniapp-sudoku');
  const start = await body(handleSessionStart(id), 200);
  const dealt = dealPuzzle(await problemSecretOf(id), id.difficulty);
  let seq = 0;
  for (let cell = 0; cell < 81; cell += 1) {
    if (dealt.puzzle.charAt(cell) !== '0') continue;
    fakeNow += 5; // super-human
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
  const rejected = await body(
    handleSessionFinalize({ ...id, session_token: start.session_token, answer: dealt.solution }),
    403
  );
  assert.match(rejected.error, /burst/);
});

// The median-cadence floor (a distinct gate lane) — sudoku at exactly 12 ops/s
// clears the burst cap but sits below the human median floor.
test('behavioural gate: sudoku rejects a sub-floor median cadence', async () => {
  const { dealPuzzle } = await import('./engines/sudoku.js');
  const id = idOf('miniapp-sudoku');
  const start = await body(handleSessionStart(id), 200);
  const dealt = dealPuzzle(await problemSecretOf(id), id.difficulty);
  let seq = 0;
  for (let cell = 0; cell < 81; cell += 1) {
    if (dealt.puzzle.charAt(cell) !== '0') continue;
    fakeNow += 90; // 12 ops fit a 1s window (passes burst) but median < 120ms
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
  const rejected = await body(
    handleSessionFinalize({ ...id, session_token: start.session_token, answer: dealt.solution }),
    403
  );
  assert.match(rejected.error, /median/);
});
