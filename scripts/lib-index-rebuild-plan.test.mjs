import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIndexRebuildChunks } from './lib-index-rebuild-plan.mjs';

test('builds bounded contiguous chunks from the migration cursor', () => {
  assert.deepEqual(buildIndexRebuildChunks(5, 2, 0), [
    [0, 2],
    [2, 2],
    [4, 1],
  ]);
  assert.deepEqual(buildIndexRebuildChunks(5, 2, 2), [
    [2, 2],
    [4, 1],
  ]);
});

test('returns no work when the cursor has reached the registry end', () => {
  assert.deepEqual(buildIndexRebuildChunks(5, 2, 5), []);
});

test('rejects invalid totals, cursors, and batch sizes', () => {
  assert.throws(() => buildIndexRebuildChunks(-1, 2), /total must be a non-negative integer/);
  assert.throws(() => buildIndexRebuildChunks(2, 0), /batchSize must be a positive integer/);
  assert.throws(() => buildIndexRebuildChunks(2, 1, 3), /start must be within total/);
});
