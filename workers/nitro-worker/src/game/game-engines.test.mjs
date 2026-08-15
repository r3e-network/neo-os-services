// Deterministic game engine coverage: with a fixed 32-byte problemSecret the
// sudoku derivation must deal a valid, stable, mask-consistent puzzle and the
// 2048 counter-mode SHA-256 engine must produce a stable init board and a
// stable board/maxExp for a scripted valid move sequence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dealPuzzle, deriveSolution, DIFFICULTY_KEYS } from './engines/sudoku.js';
import { MASKS } from './engines/sudoku-data.js';
import { newRun, stepRun, replayRun, applyMove } from './engines/game2048.adapter.js';

const SECRET = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff));

function assertValidSudokuSolution(solution) {
  assert.match(solution, /^[1-9]{81}$/);
  const FULL = 0b1111111110;
  for (let unit = 0; unit < 9; unit += 1) {
    let row = 0;
    let col = 0;
    let box = 0;
    for (let k = 0; k < 9; k += 1) {
      row |= 1 << (solution.charCodeAt(unit * 9 + k) - 48);
      col |= 1 << (solution.charCodeAt(k * 9 + unit) - 48);
      const r = Math.floor(unit / 3) * 3 + Math.floor(k / 3);
      const c = (unit % 3) * 3 + (k % 3);
      box |= 1 << (solution.charCodeAt(r * 9 + c) - 48);
    }
    assert.equal(row, FULL, `row unit ${unit} incomplete`);
    assert.equal(col, FULL, `col unit ${unit} incomplete`);
    assert.equal(box, FULL, `box unit ${unit} incomplete`);
  }
}

test('sudoku: dealt puzzle is a valid-solution subset with mask-consistent clue count, stable per secret', () => {
  for (const difficulty of [0, 1, 2]) {
    const dealt = dealPuzzle(SECRET, difficulty);

    assertValidSudokuSolution(dealt.solution);
    assert.equal(dealt.solution, deriveSolution(SECRET));

    // Clues are a subset of the solution; holes are '0'.
    assert.match(dealt.puzzle, /^[0-9]{81}$/);
    let clueCount = 0;
    for (let i = 0; i < 81; i += 1) {
      const ch = dealt.puzzle.charAt(i);
      if (ch === '0') continue;
      clueCount += 1;
      assert.equal(ch, dealt.solution.charAt(i), `clue mismatch at cell ${i}`);
    }
    assert.equal(clueCount, dealt.clues);

    // Clue count matches the drawn mask's visible-cell count.
    const mask = MASKS[DIFFICULTY_KEYS[difficulty]][dealt.maskIndex];
    const maskOnes = [...mask].filter((c) => c === '1').length;
    assert.equal(dealt.clues, maskOnes);

    // Derivation is stable: same secret -> same strings.
    const again = dealPuzzle(SECRET, difficulty);
    assert.equal(again.solution, dealt.solution);
    assert.equal(again.puzzle, dealt.puzzle);
    assert.equal(again.maskIndex, dealt.maskIndex);
  }
});

test('sudoku: different difficulties share the solution but draw difficulty-scoped masks', () => {
  const easy = dealPuzzle(SECRET, 0);
  const hard = dealPuzzle(SECRET, 2);
  assert.equal(easy.solution, hard.solution);
  assert.ok(easy.clues > hard.clues, 'easy must expose more clues than hard');
});

test('2048: init board is stable and holds exactly the two initial spawns', () => {
  const runA = newRun(SECRET);
  const runB = newRun(SECRET);
  assert.deepEqual(runA.board, runB.board);
  assert.equal(runA.board.length, 16);
  const tiles = runA.board.filter((v) => v !== 0);
  assert.equal(tiles.length, 2);
  for (const exp of tiles) assert.ok(exp === 1 || exp === 2);
  assert.equal(runA.maxExp, Math.max(...runA.board));
});

test('2048: scripted valid move sequence yields identical board/maxExp across two runs', () => {
  // Script the sequence greedily off the engine itself: always the first
  // board-changing direction. 24 applied moves is plenty to cross block
  // boundaries in the counter-mode stream.
  const moves = [];
  let state = newRun(SECRET);
  while (moves.length < 24) {
    let advanced = null;
    for (let dir = 0; dir < 4 && !advanced; dir += 1) {
      const next = stepRun(SECRET, state, dir);
      if (next) {
        advanced = next;
        moves.push(dir);
      }
    }
    assert.ok(advanced, 'board locked before the script completed');
    state = advanced;
  }

  const replayA = replayRun(SECRET, moves);
  const replayB = replayRun(SECRET, moves);
  assert.ok(replayA.ok);
  assert.deepEqual(replayA.board, state.board);
  assert.equal(replayA.maxExp, state.maxExp);
  assert.deepEqual(replayA.board, replayB.board);
  assert.equal(replayA.maxExp, replayB.maxExp);
  assert.equal(replayA.applied, moves.length);
});

test('2048: no-change moves are invalid and consume no spawn', () => {
  // Construct a board where "up" is a no-op: column stacks already packed top.
  const board = [1, 2, 1, 2, 2, 1, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0];
  assert.equal(applyMove([...board], 0), false);
  const state = { board, rng: { k: 1, cursor: 4 }, maxExp: 2 };
  assert.equal(stepRun(SECRET, state, 0), null);
});
