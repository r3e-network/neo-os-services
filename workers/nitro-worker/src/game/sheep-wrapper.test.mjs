import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as sheep from './wrappers/sheep.wrapper.js';

const secret = createHash('sha256').update('sheep-wrapper-view').digest('hex');

function pickable(state) {
  return sheep
    .deal(secret, 0)
    .startView.cards.find((card) => card.exposed && !state.pickedIds.includes(card.id));
}

test('sheep wrapper returns authoritative tray and result flags for every accepted op', () => {
  const { state, startView } = sheep.deal(secret, 0);
  assert.deepEqual(startView.slots, []);

  const first = pickable(state);
  const picked = sheep.applyOp(state, { type: 'pick', cardId: first.id });
  assert.equal(picked.view.slots.length, 1);
  assert.equal(picked.view.slots[0].id, first.id);
  assert.equal(typeof picked.view.matched, 'boolean');
  assert.equal(typeof picked.view.won, 'boolean');
  assert.equal(typeof picked.view.gameOver, 'boolean');

  const shuffled = sheep.applyOp(state, { type: 'shuffle' });
  assert.equal(shuffled.view.slots[0].id, first.id);
  assert.equal(shuffled.view.matched, false);
  assert.equal(shuffled.view.shuffleLeft, 0);
});

test('sheep wrapper undo preserves accepted tool operations while removing the latest pick', () => {
  const { state } = sheep.deal(secret, 0);
  const first = pickable(state);
  sheep.applyOp(state, { type: 'pick', cardId: first.id });
  sheep.applyOp(state, { type: 'shuffle' });

  const undone = sheep.applyUndo(state);
  assert.equal(undone.view.slots.length, 0);
  assert.equal(undone.view.shuffleLeft, 0);
  assert.equal(undone.view.gameOver, false);
  assert.equal(
    state.acceptedOps.some((op) => op.type === 'pick'),
    false
  );
  assert.equal(
    state.acceptedOps.some((op) => op.type === 'shuffle'),
    true
  );
});

test('sheep wrapper rejects remove3 before three cards occupy the tray', () => {
  const { state } = sheep.deal(secret, 0);
  const result = sheep.applyOp(state, { type: 'remove3' });
  assert.equal(result.reject.status, 409);
  assert.match(result.reject.message, /at least 3 tray cards/);
});
