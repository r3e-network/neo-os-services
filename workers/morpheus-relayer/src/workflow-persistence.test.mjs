import test from 'node:test';
import assert from 'node:assert/strict';

import { buildWorkflowExecutionRecord, buildRiskEventRecord } from './workflow-persistence.js';

test('workflow persistence shapes normalized execution and risk records', () => {
  const execution = buildWorkflowExecutionRecord({
    workflowId: 'oracle.query',
    executionId: 'exec-1',
    network: 'testnet',
    route: '/testnet/oracle/query',
  });

  assert.equal(execution.workflow_id, 'oracle.query');
  assert.equal(execution.execution_id, 'exec-1');
  assert.equal(execution.network, 'testnet');
  assert.equal(execution.ingress_route, '/testnet/oracle/query');
  assert.equal(execution.status, 'queued');
  assert.equal(execution.result_envelope_version, '2026-04-tee-v1');

  const riskEvent = buildRiskEventRecord({
    scope: 'workflow',
    scope_id: 'oracle.query',
  });

  assert.equal(riskEvent.scope, 'workflow');
  assert.equal(riskEvent.scope_id, 'oracle.query');
  assert.equal(riskEvent.status, 'open');
});
