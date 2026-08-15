import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getWorkflowDefinition,
  listWorkflowDefinitions,
  PUBLIC_RISK_ACTIONS,
  PUBLIC_RUNTIME_TOPOLOGY,
  RESULT_ENVELOPE_VERSION,
} from './workflow-catalog.js';

test('workflow catalog exposes stable ids and public execution topology', () => {
  const definitions = listWorkflowDefinitions();
  const ids = definitions.map((item) => item.id);
  assert.deepEqual(ids, [
    'oracle.query',
    'oracle.smart_fetch',
    'feed.sync',
    'automation.upkeep',
    'compute.execute',
    'neodid.bind',
    'neodid.action_ticket',
    'neodid.recovery_ticket',
    'paymaster.authorize',
  ]);

  const upkeep = getWorkflowDefinition('automation.upkeep');
  assert.equal(upkeep.trigger.kind, 'scheduler');
  assert.deepEqual(upkeep.allowedNetworks, ['mainnet', 'testnet']);
  assert.equal(RESULT_ENVELOPE_VERSION, '2026-04-tee-v1');
  assert.deepEqual(PUBLIC_RUNTIME_TOPOLOGY, {
    ingressPlane: 'edge_gateway',
    orchestrationPlane: 'control_plane',
    schedulerPlane: 'control_plane',
    executionPlane: 'tee_runtime',
    riskPlane: 'independent_observer',
  });
  assert.deepEqual(PUBLIC_RISK_ACTIONS, ['observe', 'review', 'pause_scope']);
});
