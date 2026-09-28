import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTOMATION_EXECUTION_QUEUE_METHOD,
  LEGACY_AUTOMATION_QUEUE_METHOD,
  buildUpkeepDispatch,
  buildUpkeepExecutionPayload,
  isTerminalAutomationQueueFailure,
  kernelManifestSupportsAutomationExecution,
  normalizeAutomationRegistrationRequestId,
  selectAutomationQueueLane,
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

const EXECUTION_LANE_ABI = {
  abi: {
    methods: [
      { name: 'queueAutomationRequest', parameters: [{}, {}, {}, {}, {}] },
      { name: 'queueAutomationExecution', parameters: [{}, {}, {}, {}] },
    ],
  },
};
const LEGACY_ONLY_ABI = {
  abi: { methods: [{ name: 'queueAutomationRequest', parameters: [{}, {}, {}, {}, {}] }] },
};

test('normalizeAutomationRegistrationRequestId accepts only positive decimal kernel ids', () => {
  assert.equal(normalizeAutomationRegistrationRequestId('57'), '57');
  assert.equal(normalizeAutomationRegistrationRequestId(' 57 '), '57');
  assert.equal(normalizeAutomationRegistrationRequestId(57), '57');
  assert.equal(normalizeAutomationRegistrationRequestId(57n), '57');
  for (const value of ['', '0', '-1', '057', '5.7', '0x39', 'abc', null, undefined, 1.5, {}]) {
    assert.equal(normalizeAutomationRegistrationRequestId(value), '', String(value));
  }
});

test('kernelManifestSupportsAutomationExecution binds to the four-argument execution lane', () => {
  assert.equal(kernelManifestSupportsAutomationExecution(EXECUTION_LANE_ABI), true);
  assert.equal(kernelManifestSupportsAutomationExecution(LEGACY_ONLY_ABI), false);
  // A method with the right name but another arity is not the lane the dispatchers encode.
  assert.equal(
    kernelManifestSupportsAutomationExecution({
      abi: { methods: [{ name: 'queueAutomationExecution', parameters: [{}, {}, {}] }] },
    }),
    false
  );
});

test('kernelManifestSupportsAutomationExecution refuses to guess from a manifest without an ABI', () => {
  assert.throws(() => kernelManifestSupportsAutomationExecution(null), /no ABI/);
  assert.throws(() => kernelManifestSupportsAutomationExecution({}), /no ABI/);
  assert.throws(() => kernelManifestSupportsAutomationExecution({ abi: {} }), /no ABI/);
});

test('selectAutomationQueueLane uses the execution lane only with a kernel that has it and a job registration', () => {
  assert.deepEqual(
    selectAutomationQueueLane({ supportsExecutionLane: true, registrationRequestId: '57' }),
    { method: AUTOMATION_EXECUTION_QUEUE_METHOD, registrationRequestId: '57' }
  );
  assert.deepEqual(
    selectAutomationQueueLane({ supportsExecutionLane: false, registrationRequestId: '57' }),
    { method: LEGACY_AUTOMATION_QUEUE_METHOD, registrationRequestId: '' }
  );
  assert.deepEqual(
    selectAutomationQueueLane({ supportsExecutionLane: true, registrationRequestId: '' }),
    { method: LEGACY_AUTOMATION_QUEUE_METHOD, registrationRequestId: '' }
  );
  assert.deepEqual(selectAutomationQueueLane(), {
    method: LEGACY_AUTOMATION_QUEUE_METHOD,
    registrationRequestId: '',
  });
});

test('isTerminalAutomationQueueFailure recognises the kernel consent and credit reverts', () => {
  for (const reason of [
    'request fee not paid',
    'requester witness required',
    'automation spend not approved',
    'automation spend approval expired',
    'automation spend cap exceeded',
    'automation registration failed',
    'automation requester mismatch',
    'not an automation registration',
    'registration not found',
    'invalid automation execution',
  ]) {
    assert.equal(
      isTerminalAutomationQueueFailure(
        `Neo N3 automation queue test invoke faulted for 0xabc: ABORTMSG is executed. Reason: ${reason}`
      ),
      true,
      reason
    );
  }
  assert.equal(isTerminalAutomationQueueFailure('rpc timeout'), false);
  assert.equal(isTerminalAutomationQueueFailure(''), false);
  assert.equal(isTerminalAutomationQueueFailure(undefined), false);
});
