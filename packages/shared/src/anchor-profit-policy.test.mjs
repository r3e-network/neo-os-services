import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnchorRebalancePlan, rankAnchorCandidates } from './anchor-profit-policy.js';

const now = 1_000_000;
const candidates = [
  { id: 'agent-b', rewardPerNeo: 105, feeBps: 100, observedAt: now },
  { id: 'agent-a', rewardPerNeo: 100, feeBps: 0, observedAt: now },
  { id: 'agent-stale', rewardPerNeo: 999, feeBps: 0, observedAt: now - 901_000 },
];

test('ranks by net reward and excludes stale observations', () => {
  const ranked = rankAnchorCandidates(candidates, { nowMs: now, maxAgeMs: 900_000 });
  assert.deepEqual(ranked.map((entry) => entry.id), ['agent-b', 'agent-a']);
  assert.equal(ranked[0].netReward, 103);
  assert.equal(ranked[1].netReward, 100);
});

test('uses deterministic tie breaking', () => {
  const ranked = rankAnchorCandidates([
    { id: 'z', rewardPerNeo: 100, observedAt: now },
    { id: 'a', rewardPerNeo: 100, observedAt: now },
  ], { nowMs: now });
  assert.deepEqual(ranked.map((entry) => entry.id), ['a', 'z']);
});

test('builds an idempotent vote plan only when improvement clears threshold', () => {
  const plan = createAnchorRebalancePlan({
    network: 'testnet', appId: 'miniapp-profitanchor', currentAgentId: 'agent-a',
    observationBlock: 42, candidates,
  }, { nowMs: now, maxAgeMs: 900_000, minImprovementBps: 200 });
  assert.equal(plan.action, 'vote-agent');
  assert.equal(plan.targetCandidateId, 'agent-b');
  assert.equal(plan.idempotencyKey, 'testnet:miniapp-profitanchor:42:agent-b');
  assert.equal(plan.improvementBps, 300);
});

test('rejects malformed, future and excessive observations', () => {
  assert.throws(() => rankAnchorCandidates([{ id: 'x', rewardPerNeo: 1, observedAt: now + 1 }], { nowMs: now }));
  assert.throws(() => rankAnchorCandidates([{ id: 'x', rewardPerNeo: 1, feeBps: 10001, observedAt: now }], { nowMs: now }));
  assert.throws(() => createAnchorRebalancePlan({ network: 'prod', appId: 'x', observationBlock: 1, candidates }));
  assert.throws(() => createAnchorRebalancePlan({ network: 'testnet', appId: 'miniapp-trustanchor', observationBlock: 1, candidates }));
});

test('computes fee-adjusted rewards without floating point loss', () => {
  const ranked = rankAnchorCandidates([
    { id: 'large', rewardPerNeo: Number.MAX_SAFE_INTEGER, feeBps: 1, observedAt: now },
  ], { nowMs: now });
  assert.equal(ranked[0].netReward, Number((BigInt(Number.MAX_SAFE_INTEGER) * 9_999n) / 10_000n));
});

test('uses exact improvement arithmetic even beyond numeric display range', () => {
  const input = { network: 'testnet', appId: 'miniapp-profitanchor', currentAgentId: 'a', observationBlock: 1,
    candidates: [{ id: 'a', rewardPerNeo: 1, observedAt: now }, { id: 'b', rewardPerNeo: Number.MAX_SAFE_INTEGER, observedAt: now }] };
  const plan = createAnchorRebalancePlan(input, { nowMs: now, minImprovementBps: Number.MAX_SAFE_INTEGER });
  assert.equal(plan.improvementBpsExact, ((BigInt(Number.MAX_SAFE_INTEGER) - 1n) * 10000n).toString());
  assert.equal(plan.improvementBps, Number.MAX_SAFE_INTEGER);
  assert.equal(plan.action, 'vote-agent');
});

test('rejects ambiguous or unavailable candidate baselines', () => {
  const row = { id: 'a', rewardPerNeo: 1, observedAt: now };
  assert.throws(() => rankAnchorCandidates([row, row], { nowMs: now }), /duplicate/);
  const input = { network: 'testnet', appId: 'miniapp-profitanchor', currentAgentId: 'a', observationBlock: 1 };
  assert.throws(() => createAnchorRebalancePlan({ ...input, candidates: [row] }, { nowMs: now + 900001 }), /no fresh/);
  assert.throws(() => createAnchorRebalancePlan({ ...input, candidates: [{ ...row, id: 'b' }] }, { nowMs: now }), /current candidate/);
});

test('does not vote for a zero-reward target with a zero threshold', () => {
  const plan = createAnchorRebalancePlan({ network: 'testnet', appId: 'miniapp-profitanchor', observationBlock: 1,
    candidates: [{ id: 'a', rewardPerNeo: 0, observedAt: now }] }, { nowMs: now });
  assert.equal(plan.action, 'no-op');
});
