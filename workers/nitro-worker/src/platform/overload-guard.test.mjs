import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireOverloadSlot, snapshotOverloadState } from './overload-guard.js';

test('acquireOverloadSlot enforces per-route in-flight caps', () => {
  process.env.MORPHEUS_MAX_INFLIGHT_COMPUTE_EXECUTE = '2';

  const first = acquireOverloadSlot('/compute/execute');
  const second = acquireOverloadSlot('/compute/execute');
  const third = acquireOverloadSlot('/compute/execute');

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(third.ok, false);
  assert.equal(third.routeName, 'compute_execute');
  assert.equal(third.limit, 2);
  assert.equal(third.inFlight, 2);
  assert.equal(snapshotOverloadState().compute_execute, 2);

  first.release();
  second.release();
  delete process.env.MORPHEUS_MAX_INFLIGHT_COMPUTE_EXECUTE;
});

test('acquireOverloadSlot caps action-routed requests that bypass the route path', () => {
  process.env.MORPHEUS_MAX_INFLIGHT_RELAY_TRANSACTION = '1';

  const first = acquireOverloadSlot('', { action: 'relay_transaction' });
  const second = acquireOverloadSlot('', { action: 'relay_transaction' });

  assert.equal(first.ok, true);
  assert.equal(first.routeName, 'relay_transaction');
  assert.equal(second.ok, false);
  assert.equal(second.routeName, 'relay_transaction');
  assert.equal(second.response.status, 503);

  first.release();
  delete process.env.MORPHEUS_MAX_INFLIGHT_RELAY_TRANSACTION;
});

test('acquireOverloadSlot release is idempotent', () => {
  process.env.MORPHEUS_MAX_INFLIGHT_ORACLE_QUERY = '1';

  const slot = acquireOverloadSlot('/oracle/query');
  assert.equal(slot.ok, true);
  assert.equal(snapshotOverloadState().oracle_query, 1);
  slot.release();
  slot.release();
  assert.equal(snapshotOverloadState().oracle_query, undefined);

  delete process.env.MORPHEUS_MAX_INFLIGHT_ORACLE_QUERY;
});
