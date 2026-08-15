import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildUpkeepDispatch,
  buildUpkeepExecutionPayload,
} from '@r3e-network/neo-os-services-shared/automation-supervisor';

test('buildUpkeepDispatch derives count-based ids with defaults', () => {
  assert.deepEqual(buildUpkeepDispatch({ automation_id: 'a1', execution_count: 0 }), {
    workflow_id: 'automation.upkeep',
    workflow_version: 1,
    automation_id: 'a1',
    execution_count: 0,
    next_execution_count: 1,
    execution_id: 'automation.upkeep:a1:1',
    request_id: 'automation:unknown:a1:1',
    idempotency_key: 'automation.upkeep:a1:1',
    replay_window: 'strict',
    delivery_mode: 'onchain_callback',
  });
});

test('buildUpkeepDispatch honors explicit chain / workflow and count-based derivation', () => {
  assert.deepEqual(
    buildUpkeepDispatch({
      automation_id: 'a1',
      chain: 'neo_n3',
      execution_count: 5,
      workflow_id: 'wf',
      workflow_version: 3,
    }),
    {
      workflow_id: 'wf',
      workflow_version: 3,
      automation_id: 'a1',
      execution_count: 5,
      next_execution_count: 6,
      execution_id: 'wf:a1:6',
      request_id: 'automation:neo_n3:a1:6',
      idempotency_key: 'wf:a1:6',
      replay_window: 'strict',
      delivery_mode: 'onchain_callback',
    }
  );
});

test('buildUpkeepDispatch requires automation_id', () => {
  assert.throws(() => buildUpkeepDispatch({}), /automation_id is required/);
});

test('request_id ignores an explicit execution_id (dedup key stays count-based)', () => {
  const dispatch = buildUpkeepDispatch({
    automation_id: 'a1',
    execution_count: 2,
    execution_id: 'random-per-request-id',
  });
  assert.equal(dispatch.execution_id, 'random-per-request-id');
  assert.equal(dispatch.request_id, 'automation:unknown:a1:3');
});

test('strict trimString: a non-string automation_id is treated as absent', () => {
  // Coercing semantics would stringify the number; strict semantics -> '' -> throws.
  assert.throws(() => buildUpkeepDispatch({ automation_id: 12345 }), /automation_id is required/);
});

test('buildUpkeepExecutionPayload spreads base payload then overlays dispatch fields', () => {
  const payload = buildUpkeepExecutionPayload(
    { extra: 'kept', workflow_id: 'overwritten' },
    { automation_id: 'a1', workflow_id: 'wf', execution_count: 0 }
  );
  assert.equal(payload.extra, 'kept');
  assert.equal(payload.workflow_id, 'wf');
  assert.equal(payload.automation_id, 'a1');
  assert.equal(payload.execution_id, 'wf:a1:1');
  assert.equal(payload.replay_window, 'strict');
});
