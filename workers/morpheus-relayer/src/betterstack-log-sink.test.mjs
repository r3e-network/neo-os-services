import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  clearLogSinkQueueForTests,
  enqueueBetterStackLog,
  getLogSinkDroppedTotal,
  resetLogSinkDroppedTotalForTests,
} from './betterstack-log-sink.js';

// The sink is a module-level singleton; configure it via env and isolate each
// test by resetting the drop counter. A small maxQueue + large batchSize keeps
// records in the in-memory queue (no flush) so overflow shedding is observable.
const ENV_KEYS = [
  'MORPHEUS_BETTERSTACK_LOG_INGESTING_HOST',
  'MORPHEUS_BETTERSTACK_LOG_SOURCE_TOKEN',
  'MORPHEUS_BETTERSTACK_LOG_MAX_QUEUE',
  'MORPHEUS_BETTERSTACK_LOG_BATCH_SIZE',
];

describe('BetterStack log sink drop counter (F7)', () => {
  let saved;

  beforeEach(() => {
    saved = {};
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    process.env.MORPHEUS_BETTERSTACK_LOG_INGESTING_HOST = 'logs.test';
    process.env.MORPHEUS_BETTERSTACK_LOG_SOURCE_TOKEN = 'token';
    process.env.MORPHEUS_BETTERSTACK_LOG_MAX_QUEUE = '10'; // floored at 10
    process.env.MORPHEUS_BETTERSTACK_LOG_BATCH_SIZE = '1000'; // never auto-flush
    clearLogSinkQueueForTests();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    clearLogSinkQueueForTests();
  });

  it('counts oldest-dropped records on overflow for non-error logs', () => {
    // Fill past the maxQueue (10) with info logs -> oldest shed + counted.
    for (let i = 0; i < 15; i += 1) {
      enqueueBetterStackLog({ level: 'info', msg: `info-${i}` });
    }
    // 15 enqueued, cap 10 -> 5 dropped.
    assert.equal(getLogSinkDroppedTotal(), 5);
  });

  it('preserves error-level logs on overflow by shedding the newest non-error records (F7)', () => {
    // 10 error logs fill the queue to the cap, then a flood of info logs arrives.
    for (let i = 0; i < 10; i += 1) {
      enqueueBetterStackLog({ level: 'error', msg: `err-${i}` });
    }
    resetLogSinkDroppedTotalForTests();
    // One more error: queue is full, incoming is error -> drop a non-error to make
    // room. There are no non-error entries, so the oldest (an error) is dropped to
    // enforce the cap, but the incoming error is retained.
    enqueueBetterStackLog({ level: 'error', msg: 'err-critical' });
    assert.equal(getLogSinkDroppedTotal(), 1);
  });

  it('drops the incoming-context newest non-error entries first when an error log overflows', () => {
    resetLogSinkDroppedTotalForTests();
    // Pre-fill with a mix: 9 info + room for 1 more (cap 10).
    for (let i = 0; i < 9; i += 1) enqueueBetterStackLog({ level: 'info', msg: `info-${i}` });
    enqueueBetterStackLog({ level: 'error', msg: 'err-early' }); // queue now exactly 10
    resetLogSinkDroppedTotalForTests();
    // Incoming error overflows by 1: a non-error (newest info) is shed, the error
    // stays. The early error is also retained.
    enqueueBetterStackLog({ level: 'error', msg: 'err-late' });
    assert.equal(getLogSinkDroppedTotal(), 1);
  });

  it('counts records dropped during a failed POST batch', async () => {
    process.env.MORPHEUS_BETTERSTACK_LOG_BATCH_SIZE = '2'; // flush at 2
    resetLogSinkDroppedTotalForTests();
    const originalFetch = global.fetch;
    global.fetch = async () => {
      throw new Error('network down');
    };
    try {
      enqueueBetterStackLog({ level: 'info', msg: 'a' });
      enqueueBetterStackLog({ level: 'info', msg: 'b' }); // reaches batchSize -> flush()
      // Allow the in-flight flush promise to settle.
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(getLogSinkDroppedTotal(), 2);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
