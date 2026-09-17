# Anchor 运营边界与收益策略

TrustAnchor (`miniapp-trustanchor`) 是治理/信用优先池：运营方人工选择可信候选人并显式调用 PlatformAnchor 的 `voteAgent`。它不运行收益最大化调仓器。

ProfitAnchor (`miniapp-profitanchor`) 才允许使用候选收益聚合、隐私计算和定时任务生成自动调仓计划。`packages/shared/src/anchor-profit-policy.js` 只接收候选人的聚合 `rewardPerNeo`、费用、观测时间和 ID，不接触用户余额、私钥或个人收益，也不直接发送交易。

策略要求：

- 过期、未来时间戳、非法费用和非法候选 ID fail-closed。
- 以扣除费用后的净 GAS/NEO 收益排序，平局按原始收益、费用和候选 ID 确定性排序。
- 所有费用和收益计算使用 BigInt 整数除法，避免 JavaScript 浮点精度损失。
- 观测区块、网络、App ID 和目标候选人组成幂等键。
- 调度器必须在执行前重新读取 PlatformAnchor 的 app mode、pause、agent、candidate 和 network identity；任何漂移都取消计划。
- 计划器只产生 `vote-agent` 或 `no-op`，签名和广播由独立的受控 worker 完成。
- `anchor-profit-scheduler.js` 要求调用方实现原子的持久租约与幂等端口；接口本身不能保证生产单飞或交易恰好执行一次。它不包含 signer，不允许把 TrustAnchor 当作自动收益池。

TrustAnchor/ProfitAnchor 两个池仍共享同一 PlatformAnchor 合约的 reward ledger；合约侧的 reward remainder、reserve、stake、claim、withdraw 由 MiniApps 的 SMT/NeoVM 验证覆盖。

## 2026-09-12 Implementation Follow-up

Local policy/scheduler corrections (not yet deployed):

- Improvement ratios and execution thresholds use exact BigInt arithmetic.
  `improvementBpsExact` preserves the full decimal integer; the existing numeric
  `improvementBps` is capped at Number.MAX_SAFE_INTEGER for display only.
- Duplicate candidate IDs, wholly stale candidate sets, and missing/stale
  current-candidate observations are rejected. Zero-reward targets do not vote.
- Candidate ID tie-breaking uses explicit code-point order rather than locale.
- No-op returns without calling storage or execution ports. Applied status is
  rechecked under the lease to close the pre-acquisition completion race.

Validation: 13 policy/scheduler tests passed. Run
`python3 packages/shared/src/formal_verify_anchor_policy.py` for six Z3 integer
lemmas (all UNSAT), covering net bounds/rounding, improvement bounds/rounding,
and equivalence of the threshold check to exact cross multiplication.
Assumptions include trusted comparable reward observations, integer fee in
0..10000, safe-integer observations, and positive current net reward for the
ratio lemmas. This is not JS/NeoVM refinement, strategy economic optimality,
source-to-deployed-contract equivalence, or complete asset-safety verification.

Current source search finds runProfitAnchorTick only in its implementation and
unit tests, not a production worker caller. Durable lease ownership/fencing,
observation refresh, signer dispatch, transaction journaling and uncertain
broadcast recovery still require implementation/verification before enabling
production automatic rebalancing. Public query acceptance is separate.

## Pool-Scoped Scheduler Follow-up (2026-09-12)

The scheduler now locks `network:appId`, not the per-observation idempotency
key. Different blocks or targets must serialize against the same pool.
After acquisition it reloads observations, rebuilds the decision, rejects
network/app drift and block regression, and rechecks the refreshed decision's
applied status. A refreshed no-op never reaches the executor.

Durable port contract (breaking change for any external adapters):

- `acquireLease(resourceKey)` returns a unique nonempty ownership token, or a
  falsy value for contention. Legacy boolean `true` is refused.
- `isLeaseOwner(resourceKey, token)` must return exactly true before execution.
- `execute(plan, {resourceKey, lease})` must enforce fencing at its signing
  boundary and journal/reconcile ambiguous broadcasts before retrying.
- `recordApplied(idempotencyKey, result, context)` must atomically verify lease
  ownership before recording confirmed execution. A broadcast txid alone is
  not confirmation of successful on-chain execution.
- `releaseLease(resourceKey, token)` must atomically compare ownership before
  deletion, so an expired worker cannot delete its successor's lease.

These are tested interface obligations, not implemented durable adapters.
The preflight ownership read does not prevent expiry during signing. `load`
must provide authenticated fresh observations, current time and canonical
block identity; height monotonicity alone does not detect a fork/reorg.

Contract source reviewed:
`neo-os-contracts/contracts/platform/PlatformAnchor/PlatformAnchor.Agents.cs`
and `PlatformAnchor.Query.cs`. `voteAgent(appId, agentId)` takes an integer
registered agent ID, checks that agent's AA witness and votes its configured
candidate. It does not transfer NEO from the previously selected agent.
The planner's string candidate IDs are not directly usable ABI arguments.
Production integration must bind candidate public key to a registered active
agent/account, verify mode=2, pause, network/genesis, approved NEF/ABI, and
explicitly account for stake placement and transaction costs. Ranking supplied
reward rates alone does not prove net-profit maximization.

Verification: 23 policy/scheduler tests and all 125 shared-package tests pass.
Six existing Z3 integer arithmetic obligations remain UNSAT; no new claim of
distributed-system, deployed-contract or economic proof is made. No service
deployment, cron activation, signing or on-chain write in this follow-up.
