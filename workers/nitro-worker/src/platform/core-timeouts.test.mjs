import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_WAIT_TIMEOUT_MS, MAX_USER_TIMEOUT_MS, cappedDurationMs } from './core.js';

test('runtime user-facing waits are capped to the 10 second SLO', () => {
  assert.equal(DEFAULT_WAIT_TIMEOUT_MS, 10_000);
  assert.equal(MAX_USER_TIMEOUT_MS, 10_000);
  assert.equal(cappedDurationMs('60s', 2000), 10_000);
});
