import { createAnchorRebalancePlan } from './anchor-profit-policy.js';

/**
 * Execute one ProfitAnchor optimization tick through injected durable ports.
 * The scheduler itself is transport- and signer-agnostic: callers must supply
 * a durable lease/idempotency store and an executor that revalidates on-chain
 * state before signing voteAgent. TrustAnchor is rejected by the policy.
 */
export async function runProfitAnchorTick({ load, store, execute }) {
  if (!load || !store || !execute) throw new Error('load, store and execute are required');
  const input = await load();
  let plan = createAnchorRebalancePlan(input, input.policyOptions);
  if (plan.action === 'no-op') return { plan, status: 'no-op' };
  if (await store.isApplied(plan.idempotencyKey)) return { plan, status: 'already-applied' };
  // Serialize the pool, not an observation: adjacent blocks can disagree.
  const resourceKey = `${plan.network}:${plan.appId}`;
  const lease = await store.acquireLease(resourceKey);
  if (!lease) return { plan, status: 'lease-held' };
  if (typeof lease !== 'string' || !lease.trim()) {
    throw new Error('durable store must return an ownership token');
  }
  const context = Object.freeze({ resourceKey, lease });
  try {
    // Another owner may have finished between the initial read and acquisition.
    if (await store.isApplied(plan.idempotencyKey)) return { plan, status: 'already-applied' };
    const refreshed = await load();
    const freshPlan = createAnchorRebalancePlan(refreshed, refreshed.policyOptions);
    if (`${freshPlan.network}:${freshPlan.appId}` !== resourceKey) {
      throw new Error('ProfitAnchor resource changed during refresh');
    }
    if (freshPlan.observationBlock < plan.observationBlock) {
      throw new Error('ProfitAnchor observation block regressed');
    }
    plan = freshPlan;
    if (plan.action === 'no-op') return { plan, status: 'no-op' };
    if (await store.isApplied(plan.idempotencyKey)) return { plan, status: 'already-applied' };
    if ((await store.isLeaseOwner(resourceKey, lease)) !== true) {
      throw new Error('ProfitAnchor lease ownership lost');
    }
    // The executor must revalidate chain state and enforce this fence at the
    // signing boundary; a preflight ownership check alone cannot fence a tx.
    const result = await execute(plan, context);
    await store.recordApplied(plan.idempotencyKey, result, context);
    return { plan, status: 'executed', result };
  } finally {
    await store.releaseLease(resourceKey, lease);
  }
}
