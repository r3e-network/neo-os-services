import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPublicRuntimeCatalog } from './lib-public-runtime-catalog.mjs';

test('public runtime catalog export exposes topology and public workflow execution metadata only', () => {
  const catalog = loadPublicRuntimeCatalog();
  assert.equal(catalog.envelope.version, '2026-04-tee-v1');
  assert.equal(catalog.networks.mainnet.network, 'mainnet');
  assert.deepEqual(catalog.topology, {
    ingressPlane: 'edge_gateway',
    orchestrationPlane: 'control_plane',
    schedulerPlane: 'control_plane',
    executionPlane: 'tee_runtime',
    riskPlane: 'independent_observer',
  });
  assert.deepEqual(catalog.risk.actions, ['observe', 'review', 'pause_scope']);
  assert.deepEqual(catalog.automation.triggerKinds, ['interval', 'threshold']);

  const upkeep = catalog.workflows.find((item) => item.id === 'automation.upkeep');
  assert.ok(upkeep);
  assert.deepEqual(upkeep.execution, {
    orchestrationPlane: 'control_plane',
    executionPlane: 'tee_runtime',
    riskPlane: 'independent_observer',
    teeRequired: true,
  });

  assert.ok(catalog.workflows.find((item) => item.id === 'paymaster.authorize'));
  assert.equal('secretEnv' in catalog, false);
  assert.equal('confidentialSteps' in catalog.workflows[0], false);
});
