import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getRequestCursorFloor,
  pruneRetryQueueBelowRequestFloor,
  resolveChainFromBlock,
} from './chain-cursor.js';

function createEmptyState() {
  return {
    neo_n3: {
      retry_queue: [],
      last_block: null,
    },
  };
}

test('getRequestCursorFloor returns a positive configured start id', () => {
  assert.equal(getRequestCursorFloor({ startRequestIds: { neo_n3: 4050 } }, 'neo_n3'), 4050);
});

test('getRequestCursorFloor returns null for missing or non-positive ids', () => {
  assert.equal(getRequestCursorFloor({ startRequestIds: { neo_n3: null } }, 'neo_n3'), null);
  assert.equal(getRequestCursorFloor({ startRequestIds: { neo_n3: 0 } }, 'neo_n3'), null);
  assert.equal(getRequestCursorFloor({ startRequestIds: {} }, 'neo_n3'), null);
});

test('pruneRetryQueueBelowRequestFloor removes items below the floor', () => {
  const state = createEmptyState();
  state.neo_n3.retry_queue = [
    { event: { requestId: 4000 } },
    { event: { requestId: 4050 } },
    { event: { requestId: 4100 } },
  ];

  const pruned = pruneRetryQueueBelowRequestFloor(state, 'neo_n3', 4050);

  assert.equal(pruned, 1);
  assert.equal(state.neo_n3.retry_queue.length, 2);
  assert.equal(state.neo_n3.retry_queue[0].event.requestId, 4050);
});

test('pruneRetryQueueBelowRequestFloor does nothing when floor is null', () => {
  const state = createEmptyState();
  state.neo_n3.retry_queue = [{ event: { requestId: 1 } }];

  assert.equal(pruneRetryQueueBelowRequestFloor(state, 'neo_n3', null), 0);
  assert.equal(state.neo_n3.retry_queue.length, 1);
});

test('resolveChainFromBlock returns the configured start block when no checkpoint exists', () => {
  const state = createEmptyState();
  const config = { startBlocks: { neo_n3: 8996388 } };

  assert.equal(resolveChainFromBlock(config, state, 'neo_n3', 8997000, null), 8996388);
});

test('resolveChainFromBlock advances from the next block after a valid checkpoint', () => {
  const state = createEmptyState();
  state.neo_n3.last_block = 8996666;
  const config = { startBlocks: { neo_n3: 8996388 } };

  assert.equal(resolveChainFromBlock(config, state, 'neo_n3', 8997000, null), 8996667);
});

test('resolveChainFromBlock throws on an invalid checkpoint', () => {
  const state = createEmptyState();
  state.neo_n3.last_block = 'not-a-number';
  const config = { startBlocks: { neo_n3: 8996388 } };

  assert.throws(
    () => resolveChainFromBlock(config, state, 'neo_n3', 8997000, null),
    /Invalid relayer checkpoint/
  );
  assert.equal(state.neo_n3.last_block, 'not-a-number');
});

test('resolveChainFromBlock throws on a checkpoint ahead of the confirmed tip', () => {
  const state = createEmptyState();
  state.neo_n3.last_block = 14258261;
  const config = { startBlocks: { neo_n3: 8996388 } };

  assert.throws(
    () => resolveChainFromBlock(config, state, 'neo_n3', 8996666, null),
    /ahead of the confirmed tip/
  );
  assert.equal(state.neo_n3.last_block, 14258261);
});
