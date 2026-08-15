import test from 'node:test';
import assert from 'node:assert/strict';

import { buildUpkeepDispatch } from './automation-supervisor.js';

test('upkeep supervisor emits idempotent automation execution intents', () => {
  const dispatch = buildUpkeepDispatch({
    automation_id: 'automation:neo_n3:123',
    workflow_id: 'automation.upkeep',
    execution_count: 4,
  });

  assert.equal(dispatch.workflow_id, 'automation.upkeep');
  assert.match(dispatch.idempotency_key, /^automation\.upkeep:/);
  assert.equal(dispatch.replay_window, 'strict');
});

test('upkeep request_id is count-based and lane-independent (execution_id never changes it)', () => {
  // The on-chain request_id is the cross-lane dedup key: it must derive only from
  // (automation_id, execution_count) so the box relayer's count-based dispatch and
  // the control-plane edge path (which carries a random per-request execution_id)
  // mint the SAME id and the kernel's "request_id already used" guard dedups across
  // lanes. A random execution_id must NOT leak into request_id.
  const withExecId = buildUpkeepDispatch({
    automation_id: 'automation:neo_n3:123',
    chain: 'neo_n3',
    execution_count: 9,
    execution_id: 'workflow-exec-1',
  });
  const withoutExecId = buildUpkeepDispatch({
    automation_id: 'automation:neo_n3:123',
    chain: 'neo_n3',
    execution_count: 9,
  });

  // execution_id is preserved for workflow/observability tracking...
  assert.equal(withExecId.execution_id, 'workflow-exec-1');
  // ...but the on-chain request_id stays count-based and identical across lanes.
  assert.equal(withExecId.request_id, 'automation:neo_n3:automation:neo_n3:123:10');
  assert.equal(withExecId.request_id, withoutExecId.request_id);
});
