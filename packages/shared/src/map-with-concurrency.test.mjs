import test from 'node:test';
import assert from 'node:assert/strict';

import { mapWithConcurrency } from './utils.js';

test('mapWithConcurrency preserves input order regardless of completion order', async () => {
  // Workers resolve out of order (later indexes finish first) but results must
  // be written back at their original index.
  const order = [];
  const results = await mapWithConcurrency([10, 20, 30, 40], 4, async (value, index) => {
    const delay = (4 - index) * 5;
    await new Promise((resolve) => setTimeout(resolve, delay));
    order.push(value);
    return value * 2;
  });
  assert.deepEqual(results, [20, 40, 60, 80]);
  // Sanity check that completion really was out of order.
  assert.deepEqual(order, [40, 30, 20, 10]);
});

test('mapWithConcurrency caps in-flight workers at the limit', async () => {
  let active = 0;
  let peak = 0;
  await mapWithConcurrency(
    Array.from({ length: 12 }, (_, i) => i),
    3,
    async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return value;
    }
  );
  assert.equal(peak, 3);
});

test('mapWithConcurrency clamps the width to [1, items.length]', async () => {
  // limit larger than the item count still works and clamps to item count.
  let peak = 0;
  let active = 0;
  const results = await mapWithConcurrency([1, 2], 100, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active -= 1;
    return value;
  });
  assert.deepEqual(results, [1, 2]);
  assert.equal(peak, 2);

  // A non-positive limit still runs at least one worker.
  const single = await mapWithConcurrency([5, 6, 7], 0, async (value) => value);
  assert.deepEqual(single, [5, 6, 7]);
});

test('mapWithConcurrency on an empty list resolves to an empty array without invoking the worker', async () => {
  let calls = 0;
  const results = await mapWithConcurrency([], 4, async () => {
    calls += 1;
  });
  assert.deepEqual(results, []);
  assert.equal(calls, 0);
});

test('mapWithConcurrency fails fast: the first thrown error rejects and idle workers stop pulling', async () => {
  // With one worker (serial), a throw on the second item must stop the cursor
  // so later items are never attempted, and the thrown error propagates.
  const attempted = [];
  await assert.rejects(
    mapWithConcurrency([1, 2, 3, 4, 5], 1, async (value) => {
      attempted.push(value);
      if (value === 2) throw new Error(`boom on ${value}`);
      return value;
    }),
    /boom on 2/
  );
  // Items 3..5 must not have been pulled after the abort.
  assert.deepEqual(attempted, [1, 2]);
});

test('mapWithConcurrency surfaces the first error and halts new work under concurrency', async () => {
  // Worker 0 throws quickly; the remaining queued items (beyond the initial
  // concurrent batch) must not be started once the abort flag is set.
  const attempted = [];
  await assert.rejects(
    mapWithConcurrency([0, 1, 2, 3, 4, 5], 2, async (value) => {
      attempted.push(value);
      if (value === 0) throw new Error('boom on 0');
      await new Promise((resolve) => setTimeout(resolve, 5));
      return value;
    }),
    /boom on 0/
  );
  // Only the first concurrent batch (0 and 1) is attempted; once 0 throws and
  // sets the abort flag, no idle worker pulls index 2+.
  assert.ok(attempted.includes(0));
  assert.ok(!attempted.includes(4));
  assert.ok(!attempted.includes(5));
});
