import { describe, expect, it } from 'vitest';

describe('workflow runtime catalog', () => {
  it('returns workflow and policy metadata without secrets', async () => {
    const { getPublicWorkflowCatalog, getPublicPolicyCatalog } =
      await import('../lib/workflow-runtime');

    const catalog = getPublicWorkflowCatalog();
    expect(catalog.workflows.some((item) => item.id === 'compute.execute')).toBe(true);
    expect('service_role_key' in catalog).toBe(false);

    const policies = getPublicPolicyCatalog();
    expect(policies.policies.some((item) => item.id === 'risk')).toBe(true);
  });

  it('returns runtime discovery metadata for canonical public endpoints', async () => {
    const { getPublicRuntimeCatalogSummary } = await import('../lib/workflow-runtime');

    const summary = getPublicRuntimeCatalogSummary();
    expect(summary.topology).toEqual({
      ingressPlane: 'edge_gateway',
      orchestrationPlane: 'control_plane',
      schedulerPlane: 'control_plane',
      executionPlane: 'tee_runtime',
      riskPlane: 'independent_observer',
    });
    expect(summary.risk.actions).toContain('pause_scope');
    expect(summary.automation.triggerKinds).toContain('interval');
    expect(summary.workflows.count).toBeGreaterThan(0);
    expect(summary.workflows.ids).toContain('automation.upkeep');
    expect(summary.links).toEqual({
      catalog: '/api/runtime/catalog',
      workflows: '/api/workflows',
      policies: '/api/policies',
    });
  });
});
