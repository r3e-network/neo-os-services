/**
 * Privacy-safe TrustAnchor/ProfitAnchor candidate policy.
 *
 * The planner consumes only aggregate candidate observations. It never sees
 * user balances, private keys or per-user rewards, and it never broadcasts a
 * transaction. A separate signer/scheduler must validate the returned plan
 * against the live PlatformAnchor state before execution.
 */

const MAX_CANDIDATES = 64;
const DEFAULT_MAX_AGE_MS = 15 * 60 * 1000;

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return value;
}

function candidateId(value) {
  const id = String(value ?? '').trim();
  if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(id)) throw new Error('candidate id is invalid');
  return id;
}

/** Return fresh, valid candidates ranked by net reward per NEO. */
export function rankAnchorCandidates(candidates, options = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0 || candidates.length > MAX_CANDIDATES) {
    throw new Error('candidate observations must contain 1..64 entries');
  }
  const nowMs = integer(options.nowMs ?? Date.now(), 'nowMs');
  const maxAgeMs = integer(options.maxAgeMs ?? DEFAULT_MAX_AGE_MS, 'maxAgeMs');
  const ids = new Set();
  const ranked = candidates.map((raw) => {
    const id = candidateId(raw?.id);
    if (ids.has(id)) throw new Error('duplicate candidate id');
    ids.add(id);
    const rewardPerNeo = integer(raw?.rewardPerNeo, `${id}.rewardPerNeo`);
    const feeBps = integer(raw?.feeBps ?? 0, `${id}.feeBps`);
    const observedAt = integer(raw?.observedAt, `${id}.observedAt`);
    if (feeBps > 10_000) throw new Error(`${id}.feeBps exceeds 10000`);
    if (observedAt > nowMs) throw new Error(`${id}.observedAt is in the future`);
    if (nowMs - observedAt > maxAgeMs) return null;
    // Use integer arithmetic so multiplying by basis points never loses GAS
    // precision near the safe-integer boundary.
    const netReward = Number((BigInt(rewardPerNeo) * BigInt(10_000 - feeBps)) / 10_000n);
    return { id, rewardPerNeo, feeBps, observedAt, netReward };
  }).filter(Boolean);
  return ranked.sort((a, b) =>
    b.netReward - a.netReward ||
    b.rewardPerNeo - a.rewardPerNeo ||
    a.feeBps - b.feeBps ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** Build an idempotent, execution-free rebalance decision. */
export function createAnchorRebalancePlan(input, options = {}) {
  const network = String(input?.network ?? '').trim();
  const appId = String(input?.appId ?? '').trim();
  if (!/^(mainnet|testnet)$/.test(network)) throw new Error('network must be mainnet or testnet');
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(appId)) throw new Error('appId is invalid');
  if (appId !== 'miniapp-profitanchor') throw new Error('automatic profit policy is restricted to ProfitAnchor');
  const currentAgentId = input?.currentAgentId == null ? null : candidateId(input.currentAgentId);
  const observationBlock = integer(input?.observationBlock, 'observationBlock');
  const ranked = rankAnchorCandidates(input?.candidates, options);
  const target = ranked[0];
  if (!target) throw new Error('no fresh candidate observations');
  const current = currentAgentId ? ranked.find((candidate) => candidate.id === currentAgentId) : null;
  if (currentAgentId && !current) throw new Error('current candidate has no fresh observation');
  const minImprovementBps = integer(options.minImprovementBps ?? 0, 'minImprovementBps');
  const improvementExact = current && current.netReward > 0
    ? (BigInt(target.netReward) - BigInt(current.netReward)) * 10_000n / BigInt(current.netReward)
    : target.netReward > 0 ? 10_000n : 0n;
  // Preserve the numeric display field without using it to decide execution.
  const improvementBps = Number(improvementExact > BigInt(Number.MAX_SAFE_INTEGER)
    ? BigInt(Number.MAX_SAFE_INTEGER) : improvementExact);
  const shouldRebalance = target.netReward > 0 && target.id !== currentAgentId
    && improvementExact >= BigInt(minImprovementBps);
  const idempotencyKey = `${network}:${appId}:${observationBlock}:${target.id}`;
  return {
    network,
    appId,
    observationBlock,
    targetCandidateId: target.id,
    targetNetRewardPerNeo: target.netReward,
    improvementBps,
    improvementBpsExact: improvementExact.toString(),
    action: shouldRebalance ? 'vote-agent' : 'no-op',
    idempotencyKey,
    rankedCandidates: ranked,
  };
}

export { DEFAULT_MAX_AGE_MS, MAX_CANDIDATES };
