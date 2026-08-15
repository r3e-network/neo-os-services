// Engine parity vectors — the shared driver behind the golden-vector safety net.
//
// Every registered engine is driven through its PRODUCTION wrapper ABI
// (deal -> applyOp/applyUndo -> replay -> score) with fixed 32-byte seeds,
// a fixed enclave clock and scripted op plans. The structured outcome (per-op
// state/view hashes, replay hash, canonical score) is frozen into
// engine-parity.goldens.json by scripts/capture-miniapp-engine-goldens.mjs and
// asserted by engine-parity.test.mjs. Any behavioral change — hand edit or a
// regenerated engine that diverges from the TS twin — flips a hash and names
// the exact engine/vector/op that moved.
import { createHash, createHmac } from 'node:crypto';

// Deterministic 32-byte problem secrets, same shape the host derives.
export function secretOf(label) {
  return createHmac('sha256', Buffer.alloc(32, 7)).update(label, 'utf8').digest();
}

// Order-independent canonical form: object keys sorted, Buffers/Uint8Array as
// byte lists, undefined dropped by JSON.stringify on both sides equally.
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Uint8Array) return { $bytes: [...value] };
  if (Array.isArray(value)) return value.map(canonicalize);
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
  return out;
}

export function hashOf(value) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

// The wrapper modules the vectors run against (same modules registry.js pins).
export const WRAPPER_FILES = {
  'miniapp-sudoku': './wrappers/sudoku.wrapper.js',
  'miniapp-game-2048': './wrappers/game2048.wrapper.js',
  'miniapp-flappy-dash': './wrappers/flappy.wrapper.js',
  'miniapp-snake-bounty': './wrappers/snake.wrapper.js',
  'miniapp-aim-master': './wrappers/aim.wrapper.js',
  'miniapp-color-clash': './wrappers/color.wrapper.js',
  'miniapp-merge-kingdom': './wrappers/merge.wrapper.js',
  'miniapp-pet-potion': './wrappers/pet.wrapper.js',
  'miniapp-sheep-solitaire': './wrappers/sheep.wrapper.js',
  'miniapp-jump-rush': './wrappers/jump.wrapper.js',
  'miniapp-curve-arrow': './wrappers/arrow.wrapper.js',
};

export async function loadWrappers() {
  const wrappers = {};
  for (const [appId, spec] of Object.entries(WRAPPER_FILES)) {
    wrappers[appId] = await import(new URL(spec, import.meta.url).href);
  }
  return wrappers;
}

// ── Scripted op plans ─────────────────────────────────────────────────────────
// Each plan receives the deal ({ state, startView }) and the difficulty and
// returns the ops to feed the wrapper. Plans may read the dealt state to script
// CORRECT plays (the enclave-side state is visible to the driver) — everything
// is a pure function of the fixed seed, so the scripted run is deterministic.

const moveOps = (dirs) => dirs.map((dir) => ({ type: 'move', dir }));

const VECTORS = {
  'miniapp-sudoku': [
    {
      name: 'partial solve + undo',
      seed: 'sudoku-alpha',
      difficulty: 0,
      ops: ({ state }) => {
        const ops = [];
        for (let i = 0; i < 81 && ops.length < 6; i += 1) {
          if (state.puzzle.charAt(i) === '0') {
            ops.push({ type: 'place', cell: i, digit: Number(state.solution.charAt(i)) });
          }
        }
        ops.push({ type: 'undo' });
        // Re-place the undone cell so the tail state is meaningful.
        const undone = ops[ops.length - 2];
        ops.push({ type: 'place', cell: undone.cell, digit: undone.digit });
        return ops;
      },
    },
    {
      name: 'full solve',
      seed: 'sudoku-beta',
      difficulty: 2,
      // The finalize answer travels in score()'s extra arg — the solved board.
      answer: ({ state }) => state.solution,
      ops: ({ state }) => {
        const ops = [];
        for (let i = 0; i < 81; i += 1) {
          if (state.puzzle.charAt(i) === '0') {
            ops.push({ type: 'place', cell: i, digit: Number(state.solution.charAt(i)) });
          }
        }
        return ops;
      },
    },
  ],

  'miniapp-game-2048': [
    {
      name: 'cycled moves + undo',
      seed: 'g2048-alpha',
      difficulty: 0,
      ops: () => [...moveOps([0, 1, 2, 3, 0, 1, 2, 3, 0, 1]), { type: 'undo' }, ...moveOps([2, 3])],
    },
    {
      name: 'wall-hugging run',
      seed: 'g2048-beta',
      difficulty: 1,
      ops: () => moveOps([1, 1, 0, 2, 3, 3, 2, 0, 1, 2, 1, 3, 0, 0, 2, 1]),
    },
  ],

  'miniapp-flappy-dash': [
    {
      name: 'steady cadence',
      seed: 'flappy-alpha',
      difficulty: 0,
      spacingMs: 480,
      ops: () => Array.from({ length: 14 }, () => ({ type: 'flap' })),
    },
    {
      name: 'sparse flaps hard',
      seed: 'flappy-beta',
      difficulty: 2,
      spacingMs: 700,
      ops: () => Array.from({ length: 9 }, () => ({ type: 'flap' })),
    },
  ],

  'miniapp-snake-bounty': [
    {
      name: 'spiral-ish run + undo',
      seed: 'snake-alpha',
      difficulty: 0,
      ops: () => [...moveOps([1, 1, 2, 1, 2, 2, 1, 0, 1, 2, 3, 2, 1, 1, 0, 2]), { type: 'undo' }],
    },
    {
      name: 'long patrol',
      seed: 'snake-beta',
      difficulty: 1,
      ops: () => moveOps([1, 2, 1, 2, 1, 0, 1, 0, 2, 3, 2, 3, 1, 1, 2, 0, 0, 3, 2, 1, 1, 1, 2, 2]),
    },
  ],

  'miniapp-aim-master': [
    {
      name: 'rapid shots',
      seed: 'aim-alpha',
      difficulty: 0,
      spacingMs: 350,
      ops: () => Array.from({ length: 12 }, () => ({ type: 'aim', position: 150 })),
    },
    {
      name: 'slow shots hard',
      seed: 'aim-beta',
      difficulty: 2,
      spacingMs: 620,
      ops: () => Array.from({ length: 10 }, (_, i) => ({ type: 'aim', position: (i * 37) % 300 })),
    },
  ],

  'miniapp-color-clash': [
    {
      name: 'three rounds then a mistake',
      seed: 'color-alpha',
      difficulty: 0,
      ops: ({ state }) => {
        const seq = state.sequence;
        const ops = [];
        for (let round = 1; round <= 3; round += 1) {
          for (let i = 0; i < round; i += 1) ops.push({ type: 'press', color: Number(seq[i]) });
        }
        const wrong = (Number(seq[0]) + 1) % 4;
        ops.push({ type: 'press', color: wrong });
        return ops;
      },
    },
    {
      name: 'undo mid round',
      seed: 'color-beta',
      difficulty: 1,
      ops: ({ state }) => {
        const seq = state.sequence;
        return [
          { type: 'press', color: Number(seq[0]) },
          { type: 'press', color: Number(seq[0]) },
          { type: 'undo' },
          { type: 'press', color: Number(seq[0]) },
          { type: 'press', color: Number(seq[1]) },
        ];
      },
    },
  ],

  'miniapp-merge-kingdom': [
    {
      name: 'greedy legal moves',
      seed: 'merge-alpha',
      difficulty: 0,
      ops: ({ state }) => {
        // Script a fixed number of greedy moves off the dealt board; every op is
        // a pure function of the seed-dealt board, so the run is deterministic.
        const ops = [];
        const board = [...state.merge.board];
        const at = (r, c) => board[r * 4 + c];
        const set = (r, c, v) => {
          board[r * 4 + c] = v;
        };
        for (let n = 0; n < 10; n += 1) {
          let chosen = null;
          outer: for (let r = 0; r < 4; r += 1) {
            for (let c = 0; c < 4; c += 1) {
              const v = at(r, c);
              if (v === 0) continue;
              for (const [dr, dc] of [
                [0, 1],
                [1, 0],
                [0, -1],
                [-1, 0],
              ]) {
                const r2 = r + dr;
                const c2 = c + dc;
                if (r2 < 0 || r2 > 3 || c2 < 0 || c2 > 3) continue;
                const w = at(r2, c2);
                if (w === v) {
                  chosen = { from: { row: r, col: c }, to: { row: r2, col: c2 }, kind: 'merge' };
                  break outer;
                }
                if (w === 0 && !chosen) {
                  chosen = {
                    from: { row: r, col: c },
                    to: { row: r2, col: c2 },
                    kind: 'reposition',
                  };
                }
              }
            }
          }
          if (!chosen) break;
          ops.push({ type: 'move', from: chosen.from, to: chosen.to });
          // Track the board locally (spawns are enclave-side; a merge op leaves
          // the source empty and doubles the target — the spawn cell stays
          // unknown here, so treat the target as occupied and move on).
          set(
            chosen.to.row,
            chosen.to.col,
            at(chosen.from.row, chosen.from.col) * (chosen.kind === 'merge' ? 2 : 1)
          );
          set(chosen.from.row, chosen.from.col, 0);
        }
        return ops;
      },
    },
    {
      name: 'fixed moves with an illegal one',
      seed: 'merge-beta',
      difficulty: 1,
      ops: () => [
        { type: 'move', from: { row: 0, col: 0 }, to: { row: 0, col: 1 } },
        { type: 'move', from: { row: 3, col: 3 }, to: { row: 3, col: 2 } },
        { type: 'move', from: { row: 1, col: 1 }, to: { row: 2, col: 1 } },
        { type: 'move', from: { row: 0, col: 0 }, to: { row: 2, col: 2 } }, // not adjacent
        { type: 'move', from: { row: 2, col: 0 }, to: { row: 2, col: 1 } },
      ],
    },
  ],

  'miniapp-pet-potion': [
    {
      name: 'balanced care cadence',
      seed: 'pet-alpha',
      difficulty: 0,
      spacingMs: 2000,
      ops: () =>
        ['feed', 'play', 'rest', 'pet', 'feed', 'play', 'rest', 'pet', 'feed', 'play'].map(
          (type) => ({ type })
        ),
    },
    {
      name: 'burst rejected by the spacing gate',
      seed: 'pet-beta',
      difficulty: 1,
      spacingMs: 800,
      ops: () => ['feed', 'play', 'pet', 'rest', 'feed', 'play'].map((type) => ({ type })),
    },
  ],

  'miniapp-sheep-solitaire': [
    {
      name: 'pick every exposed card',
      seed: 'sheep-alpha',
      difficulty: 0,
      // Only top-layer cards are exposed at the deal; ids alone are not
      // pickable (bottom layers are dealt first), so script from the view.
      ops: ({ startView }) =>
        startView.cards
          .filter((card) => card.exposed)
          .slice(0, 6)
          .map((card) => ({ type: 'pick', cardId: card.id })),
    },
    {
      name: 'picks with shuffle and remove3',
      seed: 'sheep-beta',
      difficulty: 1,
      ops: ({ startView }) => {
        const exposed = startView.cards.filter((card) => card.exposed).map((card) => card.id);
        return [
          ...exposed.slice(0, 3).map((cardId) => ({ type: 'pick', cardId })),
          { type: 'shuffle' },
          ...exposed.slice(3, 6).map((cardId) => ({ type: 'pick', cardId })),
          { type: 'remove3' },
          ...exposed.slice(6, 8).map((cardId) => ({ type: 'pick', cardId })),
        ];
      },
    },
  ],

  'miniapp-jump-rush': [
    {
      name: 'ideal charges then misses',
      seed: 'jump-alpha',
      difficulty: 0,
      ops: ({ state }) => {
        const ops = [];
        for (let i = 0; i < 5 && i + 1 < state.platforms.length; i += 1) {
          const gap = state.platforms[i + 1].gap;
          ops.push({ type: 'jump', chargeLevel: Math.min(100, Math.max(0, 50 + gap / 4)) });
        }
        ops.push({ type: 'jump', chargeLevel: 10 }, { type: 'jump', chargeLevel: 95 });
        return ops;
      },
    },
    {
      name: 'fixed charges hard',
      seed: 'jump-beta',
      difficulty: 2,
      ops: () =>
        [55, 62, 48, 70, 51, 66, 58, 44].map((chargeLevel) => ({ type: 'jump', chargeLevel })),
    },
  ],

  'miniapp-curve-arrow': [
    {
      name: 'single-pair shots',
      seed: 'arrow-alpha',
      difficulty: 0,
      ops: () => [
        { type: 'shot', holds: [8, 30] },
        { type: 'shot', holds: [12, 44] },
        { type: 'shot', holds: [0, 18] },
        { type: 'shot', holds: [20, 55] },
      ],
    },
    {
      name: 'multi-pair shots hard',
      seed: 'arrow-beta',
      difficulty: 2,
      ops: () => [
        { type: 'shot', holds: [0, 12, 40, 60] },
        { type: 'shot', holds: [5, 25, 60, 90] },
        { type: 'shot', holds: [30, 70] },
      ],
    },
  ],
};

export function vectorPlans() {
  return VECTORS;
}

// ── Driver ────────────────────────────────────────────────────────────────────

const STARTED_AT_MS = 1_770_000_000_000; // fixed enclave clock origin

function isUndo(op) {
  return typeof op?.type === 'string' && op.type.trim() === 'undo';
}

// Run one vector through a wrapper module and return the structured outcome.
// ops are recorded in the outcome so the goldens file is self-contained.
export function runVector(wrapper, plan) {
  const difficulty = plan.difficulty ?? 0;
  const spacingMs = plan.spacingMs ?? 2000;
  const problemSecret = secretOf(plan.seed);

  const { state: dealtState, startView } = wrapper.deal(problemSecret, difficulty);
  const ops = plan.ops({ state: dealtState, startView });

  let state = dealtState;
  const opOutcomes = [];
  const appliedOps = [];
  ops.forEach((op, i) => {
    const elapsedMs = (i + 1) * spacingMs;
    const opMeta = {
      problemSecret,
      difficulty,
      nowMs: STARTED_AT_MS + elapsedMs,
      startedAtMs: STARTED_AT_MS,
      elapsedMs,
      resumed: false,
      opIndex: i,
    };
    const result = isUndo(op)
      ? wrapper.applyUndo(state, opMeta)
      : wrapper.applyOp(state, op, opMeta);
    state = result.state;
    // The host records accepted-but-null ops (view.ok === false) but the replay
    // rejects them — only reject-free, non-null ops reach the finalize log.
    if (!result.reject && result.view?.ok !== false) appliedOps.push(op);
    opOutcomes.push({
      rejected: result.reject
        ? { message: result.reject.message, status: result.reject.status }
        : null,
      viewHash: result.view === undefined ? null : hashOf(result.view),
      stateHash: hashOf(state),
    });
  });

  const totalElapsedMs = ops.length * spacingMs;
  const scoreExtra = {
    problemSecret,
    difficulty,
    nowMs: STARTED_AT_MS + totalElapsedMs,
    startedAtMs: STARTED_AT_MS,
    elapsedMs: totalElapsedMs,
    resumed: false,
    opIndex: ops.length,
    // Some engines (sudoku) take the finalize answer in score()'s extra arg.
    answer:
      typeof plan.answer === 'function' ? plan.answer({ state: dealtState, startView }) : undefined,
  };

  let replay;
  try {
    replay = { stateHash: hashOf(wrapper.replay(problemSecret, appliedOps, difficulty)) };
  } catch (error) {
    replay = { threw: error instanceof Error ? error.message : String(error) };
  }

  let score;
  try {
    score = { result: canonicalize(wrapper.score(state, difficulty, scoreExtra)) };
  } catch (error) {
    score = {
      rejected: error instanceof Error ? error.message : String(error),
      status: typeof error?.status === 'number' ? error.status : null,
    };
  }

  return {
    name: plan.name,
    seed: plan.seed,
    difficulty,
    spacingMs,
    ops,
    outcome: {
      startViewHash: hashOf(startView),
      initialStateHash: hashOf(dealtState),
      liveStateHash: hashOf(state),
      ops: opOutcomes,
      replay,
      score,
    },
  };
}

// Run every engine's vectors. `wrappers` maps appId -> wrapper module.
export function runAllVectors(wrappers, plans = VECTORS) {
  const results = {};
  for (const [appId, vectors] of Object.entries(plans)) {
    const wrapper = wrappers[appId];
    if (!wrapper) throw new Error(`no wrapper loaded for ${appId}`);
    results[appId] = { vectors: vectors.map((plan) => runVector(wrapper, plan)) };
  }
  return results;
}
