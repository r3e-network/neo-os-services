import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeExecutionPlan } from './execution-plan.js';
import { buildResultEnvelope } from './result-envelope.js';

test('execution plan strips ingress details before TEE execution', () => {
  const plan = normalizeExecutionPlan({
    workflow_id: 'oracle.query',
    execution_id: 'exec-1',
    network: 'testnet',
    route: '/testnet/oracle/query',
    payload: { provider: 'coinbase-spot', secret_token: 'never-forward' },
  });

  assert.equal(plan.workflow_id, 'oracle.query');
  assert.equal('route' in plan, false);
  assert.equal(buildResultEnvelope(plan, { ok: true }).version, '2026-04-tee-v1');
});
