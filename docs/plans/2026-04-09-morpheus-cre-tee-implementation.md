# Morpheus CRE-Style TEE Runtime Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor `neo-morpheus-oracle` into a typed workflow platform with explicit workflow registry, keeper-style supervision, policy enforcement, normalized execution envelopes, and risk observation, while exporting generated public runtime metadata into `neo-miniapps-platform` and `neo-abstract-account`.

**Architecture:** Keep orchestration, scheduling, rate limiting, and durable state outside the TEE. The control plane resolves a workflow definition plus policy decision into a normalized execution plan, the Phala worker executes only the confidential steps, and the relayer/app backend deliver one signed result envelope. Public consumers import generated artifacts from Morpheus instead of hardcoding route families or policy assumptions.

**Tech Stack:** Cloudflare Workers, Cloudflare Queues/Workflows, Supabase/Postgres migrations, Next.js, Node.js built-in test runner, Vitest, Phala TEE worker, Neon JS, shell validation scripts.

**Implementation Notes:**

- Use `@superpowers:test-driven-development` during execution.
- Preserve compatibility wrappers for legacy routes such as `/oracle/query` and `/automation/execute` until the generated artifact rollout is complete.
- Never emit secrets in generated JSON or stdout. Generated artifacts stay public-only.
- Treat Chainlink CRE as the workflow/orchestration reference and Chainlink Privacy as the confidential execution reference. Morpheus remains TEE-based.

### Task 1: Canonical Workflow Catalog

**Files:**

- Create: `packages/shared/src/workflow-catalog.js`
- Create: `packages/shared/src/workflow-catalog.test.mjs`
- Modify: `packages/shared/src/index.js`
- Modify: `packages/shared/src/index.ts`
- Modify: `workers/phala-worker/src/capabilities.js`

**Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getWorkflowDefinition,
  listWorkflowDefinitions,
  RESULT_ENVELOPE_VERSION,
} from './workflow-catalog.js';

test('workflow catalog exposes stable ids and execution boundaries', () => {
  const ids = listWorkflowDefinitions().map((item) => item.id);
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
  assert.equal(getWorkflowDefinition('automation.upkeep').trigger.kind, 'scheduler');
  assert.equal(RESULT_ENVELOPE_VERSION, '2026-04-tee-v1');
});
```

**Step 2: Run test to verify it fails**

Run: `node --test packages/shared/src/workflow-catalog.test.mjs`
Expected: FAIL with `Cannot find module './workflow-catalog.js'` or missing export errors.

**Step 3: Write minimal implementation**

```js
export const RESULT_ENVELOPE_VERSION = '2026-04-tee-v1';

const WORKFLOW_DEFINITIONS = [
  {
    id: 'automation.upkeep',
    version: 1,
    trigger: { kind: 'scheduler', supported: ['interval', 'threshold'] },
    confidentialSteps: ['payload_decrypt', 'provider_fetch', 'sign_result'],
    delivery: { mode: 'onchain_callback' },
    policies: ['tenant', 'provider', 'paymaster', 'risk'],
  },
];

export function listWorkflowDefinitions() {
  return WORKFLOW_DEFINITIONS.map((item) => ({ ...item }));
}

export function getWorkflowDefinition(id) {
  return WORKFLOW_DEFINITIONS.find((item) => item.id === id) ?? null;
}
```

**Step 4: Run test to verify it passes**

Run: `node --test packages/shared/src/workflow-catalog.test.mjs`
Expected: PASS with stable workflow ids and envelope version.

**Step 5: Commit**

```bash
git add packages/shared/src/workflow-catalog.js \
  packages/shared/src/workflow-catalog.test.mjs \
  packages/shared/src/index.js \
  packages/shared/src/index.ts \
  workers/phala-worker/src/capabilities.js
git commit -m "feat: add canonical workflow catalog"
```

### Task 2: Public Runtime Catalog Exporter

**Files:**

- Create: `scripts/lib-public-runtime-catalog.mjs`
- Create: `scripts/export-public-runtime-catalog.mjs`
- Create: `scripts/export-public-runtime-catalog.test.mjs`
- Modify: `scripts/check-web-consistency.mjs`
- Modify: `README.md`

**Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPublicRuntimeCatalog } from './lib-public-runtime-catalog.mjs';

test('public runtime catalog stays public and network-aware', () => {
  const catalog = loadPublicRuntimeCatalog();
  assert.equal(catalog.envelope.version, '2026-04-tee-v1');
  assert.ok(catalog.workflows.find((item) => item.id === 'automation.upkeep'));
  assert.equal('secretEnv' in catalog, false);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test scripts/export-public-runtime-catalog.test.mjs`
Expected: FAIL with missing module or missing `loadPublicRuntimeCatalog`.

**Step 3: Write minimal implementation**

```js
import { loadPublicNetworkRegistry } from './lib-public-network-registry.mjs';
import {
  listWorkflowDefinitions,
  RESULT_ENVELOPE_VERSION,
} from '../packages/shared/src/workflow-catalog.js';

export function loadPublicRuntimeCatalog() {
  return {
    envelope: { version: RESULT_ENVELOPE_VERSION },
    networks: loadPublicNetworkRegistry(),
    workflows: listWorkflowDefinitions().map((item) => ({
      id: item.id,
      version: item.version,
      delivery: item.delivery,
      trigger: item.trigger,
      policies: item.policies,
    })),
  };
}
```

**Step 4: Run test to verify it passes**

Run: `node --test scripts/export-public-runtime-catalog.test.mjs`
Expected: PASS and no secret-bearing keys in the exported catalog.

**Step 5: Commit**

```bash
git add scripts/lib-public-runtime-catalog.mjs \
  scripts/export-public-runtime-catalog.mjs \
  scripts/export-public-runtime-catalog.test.mjs \
  scripts/check-web-consistency.mjs \
  README.md
git commit -m "feat: export public morpheus runtime catalog"
```

### Task 3: Workflow Runtime and Policy Persistence

**Files:**

- Create: `supabase/migrations/0011_workflow_runtime.sql`
- Create: `supabase/migrations/0012_policy_and_risk_controls.sql`
- Create: `workers/morpheus-relayer/src/workflow-persistence.js`
- Create: `workers/morpheus-relayer/src/workflow-persistence.test.mjs`
- Modify: `workers/morpheus-relayer/src/persistence.js`
- Modify: `apps/web/lib/server-supabase.ts`

**Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkflowExecutionRecord, buildRiskEventRecord } from './workflow-persistence.js';

test('workflow persistence shapes normalized execution records', () => {
  const record = buildWorkflowExecutionRecord({
    workflowId: 'oracle.query',
    executionId: 'exec-1',
    network: 'testnet',
    route: '/testnet/oracle/query',
  });
  assert.equal(record.workflow_id, 'oracle.query');
  assert.equal(record.status, 'queued');
  assert.equal(record.result_envelope_version, '2026-04-tee-v1');
  assert.equal(
    buildRiskEventRecord({ scope: 'workflow', scope_id: 'oracle.query' }).status,
    'open'
  );
});
```

**Step 2: Run test to verify it fails**

Run: `node --test workers/morpheus-relayer/src/workflow-persistence.test.mjs`
Expected: FAIL with missing module or missing helpers.

**Step 3: Write minimal implementation**

```js
import { RESULT_ENVELOPE_VERSION } from '@r3e-network/neo-os-services-shared/workflow-catalog';

export function buildWorkflowExecutionRecord(input) {
  return {
    workflow_id: input.workflowId,
    execution_id: input.executionId,
    network: input.network,
    ingress_route: input.route,
    status: 'queued',
    result_envelope_version: RESULT_ENVELOPE_VERSION,
  };
}

export function buildRiskEventRecord(input) {
  return {
    scope: input.scope,
    scope_id: input.scope_id,
    status: 'open',
  };
}
```

**Step 4: Run test to verify it passes**

Run: `node --test workers/morpheus-relayer/src/workflow-persistence.test.mjs`
Expected: PASS and migration-backed helper shapes match the new schema.

**Step 5: Commit**

```bash
git add supabase/migrations/0011_workflow_runtime.sql \
  supabase/migrations/0012_policy_and_risk_controls.sql \
  workers/morpheus-relayer/src/workflow-persistence.js \
  workers/morpheus-relayer/src/workflow-persistence.test.mjs \
  workers/morpheus-relayer/src/persistence.js \
  apps/web/lib/server-supabase.ts
git commit -m "feat: add workflow runtime persistence"
```

### Task 4: Control Plane Workflow Dispatch and Compatibility Routing

**Files:**

- Create: `deploy/cloudflare/morpheus-control-plane/lib/workflow-dispatch.js`
- Modify: `deploy/cloudflare/morpheus-control-plane/lib/config.js`
- Modify: `deploy/cloudflare/morpheus-control-plane/lib/workflows.js`
- Modify: `deploy/cloudflare/morpheus-control-plane/lib/workflows-impl.js`
- Modify: `deploy/cloudflare/morpheus-control-plane/lib/queue-consumer.js`
- Modify: `deploy/cloudflare/morpheus-control-plane/worker.mjs`
- Modify: `deploy/cloudflare/morpheus-control-plane/worker.test.mjs`

**Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.mjs';

test('legacy route dispatches through typed workflow metadata', async () => {
  const response = await worker.fetch(
    new Request('https://control.meshmini.app/testnet/oracle/query', {
      method: 'POST',
      headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'coinbase-spot', symbol: 'NEO-USD' }),
    }),
    buildEnv()
  );
  const body = await response.json();
  assert.equal(body.metadata.workflow_id, 'oracle.query');
  assert.equal(body.metadata.workflow_version, 1);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test deploy/cloudflare/morpheus-control-plane/worker.test.mjs`
Expected: FAIL because the response metadata only reflects route-local queue config.

**Step 3: Write minimal implementation**

```js
export function resolveWorkflowDispatch(routePath, payload) {
  const workflowId =
    routePath === '/oracle/query'
      ? 'oracle.query'
      : routePath === '/automation/execute'
        ? 'automation.upkeep'
        : null;
  if (!workflowId) throw new Error(`unsupported workflow route: ${routePath}`);
  return {
    workflowId,
    workflowVersion: 1,
    executionId: crypto.randomUUID(),
    legacyRoute: routePath,
    payload,
  };
}
```

**Step 4: Run test to verify it passes**

Run: `node --test deploy/cloudflare/morpheus-control-plane/worker.test.mjs`
Expected: PASS with legacy routes mapped onto workflow ids and execution ids.

**Step 5: Commit**

```bash
git add deploy/cloudflare/morpheus-control-plane/lib/workflow-dispatch.js \
  deploy/cloudflare/morpheus-control-plane/lib/config.js \
  deploy/cloudflare/morpheus-control-plane/lib/workflows.js \
  deploy/cloudflare/morpheus-control-plane/lib/workflows-impl.js \
  deploy/cloudflare/morpheus-control-plane/lib/queue-consumer.js \
  deploy/cloudflare/morpheus-control-plane/worker.mjs \
  deploy/cloudflare/morpheus-control-plane/worker.test.mjs
git commit -m "feat: route control plane through workflow registry"
```

### Task 5: Keeper Supervisor and Unified Automation Upkeeps

**Files:**

- Create: `workers/morpheus-relayer/src/automation-supervisor.js`
- Create: `workers/morpheus-relayer/src/automation-supervisor.test.mjs`
- Modify: `workers/morpheus-relayer/src/automation.js`
- Modify: `workers/morpheus-relayer/src/request-processor.js`
- Modify: `workers/morpheus-relayer/src/fulfillment.js`
- Modify: `apps/web/app/api/internal/control-plane/automation-execute/route.ts`

**Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUpkeepDispatch } from './automation-supervisor.js';

test('upkeep supervisor emits idempotent automation execution intents', () => {
  const dispatch = buildUpkeepDispatch({
    automation_id: 'automation:neo_n3:123',
    workflow_id: 'automation.upkeep',
    execution_count: 4,
  });
  assert.equal(dispatch.workflow_id, 'automation.upkeep');
  assert.match(dispatch.idempotency_key, /^automation\.upkeep:/);
  assert.equal(dispatch.replay_window, 'strict');
});
```

**Step 2: Run test to verify it fails**

Run: `node --test workers/morpheus-relayer/src/automation-supervisor.test.mjs`
Expected: FAIL with missing module or missing `buildUpkeepDispatch`.

**Step 3: Write minimal implementation**

```js
export function buildUpkeepDispatch(job) {
  return {
    workflow_id: 'automation.upkeep',
    automation_id: job.automation_id,
    idempotency_key: `automation.upkeep:${job.automation_id}:${job.execution_count + 1}`,
    replay_window: 'strict',
    delivery_mode: 'onchain_callback',
  };
}
```

**Step 4: Run test to verify it passes**

Run: `node --test workers/morpheus-relayer/src/automation-supervisor.test.mjs workers/morpheus-relayer/src/fulfillment.test.mjs`
Expected: PASS and no duplicate queueing when the same upkeep is replayed.

**Step 5: Commit**

```bash
git add workers/morpheus-relayer/src/automation-supervisor.js \
  workers/morpheus-relayer/src/automation-supervisor.test.mjs \
  workers/morpheus-relayer/src/automation.js \
  workers/morpheus-relayer/src/request-processor.js \
  workers/morpheus-relayer/src/fulfillment.js \
  apps/web/app/api/internal/control-plane/automation-execute/route.ts
git commit -m "feat: add upkeep supervisor for automation workflows"
```

### Task 6: TEE Execution Plan and Result Envelope

**Files:**

- Create: `workers/phala-worker/src/platform/execution-plan.js`
- Create: `workers/phala-worker/src/platform/result-envelope.js`
- Create: `workers/phala-worker/src/platform/execution-plan.test.mjs`
- Modify: `workers/phala-worker/src/worker.js`
- Modify: `workers/phala-worker/src/platform/request-guards.js`
- Modify: `workers/phala-worker/src/workflow.test.mjs`

**Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeExecutionPlan } from './execution-plan.js';
import { buildResultEnvelope } from './result-envelope.js';

test('execution plan strips ingress details before TEE execution', () => {
  const plan = normalizeExecutionPlan({
    workflow_id: 'oracle.query',
    execution_id: 'exec-1',
    network: 'testnet',
    payload: { provider: 'coinbase-spot', auth_ref: '<secret-reference>' },
  });
  assert.equal(plan.workflow_id, 'oracle.query');
  assert.equal('route' in plan, false);
  assert.equal(buildResultEnvelope(plan, { ok: true }).version, '2026-04-tee-v1');
});
```

**Step 2: Run test to verify it fails**

Run: `node --test workers/phala-worker/src/platform/execution-plan.test.mjs`
Expected: FAIL because the worker still consumes product-specific payload shapes directly.

**Step 3: Write minimal implementation**

```js
export function normalizeExecutionPlan(input) {
  return {
    workflow_id: input.workflow_id,
    execution_id: input.execution_id,
    network: input.network,
    provider_refs: input.provider_refs ?? [],
    sealed_inputs: input.sealed_inputs ?? {},
    step_list: input.step_list ?? [],
  };
}

export function buildResultEnvelope(plan, result) {
  return {
    version: '2026-04-tee-v1',
    workflow_id: plan.workflow_id,
    execution_id: plan.execution_id,
    network: plan.network,
    status: result.ok ? 'succeeded' : 'failed',
  };
}
```

**Step 4: Run test to verify it passes**

Run: `node --test workers/phala-worker/src/platform/execution-plan.test.mjs workers/phala-worker/src/workflow.test.mjs`
Expected: PASS with one stable envelope format across oracle, compute, NeoDID, and paymaster flows.

**Step 5: Commit**

```bash
git add workers/phala-worker/src/platform/execution-plan.js \
  workers/phala-worker/src/platform/result-envelope.js \
  workers/phala-worker/src/platform/execution-plan.test.mjs \
  workers/phala-worker/src/worker.js \
  workers/phala-worker/src/platform/request-guards.js \
  workers/phala-worker/src/workflow.test.mjs
git commit -m "feat: normalize tee execution plans and result envelopes"
```

### Task 7: Policy Engine and Risk Observer

**Files:**

- Create: `workers/phala-worker/src/platform/policy-engine.js`
- Create: `workers/phala-worker/src/platform/policy-engine.test.mjs`
- Create: `workers/phala-worker/src/platform/risk-observer.js`
- Create: `workers/phala-worker/src/platform/risk-observer.test.mjs`
- Modify: `workers/phala-worker/src/platform/circuit-breaker.js`
- Modify: `workers/phala-worker/src/platform/request-guards.js`
- Modify: `apps/web/lib/provider-configs.ts`
- Modify: `apps/web/lib/neo-control-plane.ts`

**Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePolicyDecision } from './policy-engine.js';
import { classifyRiskSignal } from './risk-observer.js';

test('policy engine denies disabled providers before TEE execution', () => {
  const decision = evaluatePolicyDecision({
    workflow_id: 'paymaster.authorize',
    provider_enabled: false,
    require_attestation: true,
  });
  assert.equal(decision.allow, false);
  assert.equal(decision.reason, 'provider_disabled');
  assert.equal(classifyRiskSignal({ failure_rate: 1, scope: 'provider' }).action, 'pause_scope');
});
```

**Step 2: Run test to verify it fails**

Run: `node --test workers/phala-worker/src/platform/policy-engine.test.mjs workers/phala-worker/src/platform/risk-observer.test.mjs`
Expected: FAIL with missing modules or missing `evaluatePolicyDecision`.

**Step 3: Write minimal implementation**

```js
export function evaluatePolicyDecision(input) {
  if (!input.provider_enabled) {
    return { allow: false, reason: 'provider_disabled' };
  }
  return { allow: true, reason: 'allowed' };
}

export function classifyRiskSignal(signal) {
  if (Number(signal.failure_rate || 0) >= 1) {
    return { action: 'pause_scope', scope: signal.scope };
  }
  return { action: 'observe', scope: signal.scope };
}
```

**Step 4: Run test to verify it passes**

Run: `node --test workers/phala-worker/src/platform/policy-engine.test.mjs workers/phala-worker/src/platform/risk-observer.test.mjs`
Expected: PASS and pause/circuit-breaker behavior is explicit instead of ad hoc.

**Step 5: Commit**

```bash
git add workers/phala-worker/src/platform/policy-engine.js \
  workers/phala-worker/src/platform/policy-engine.test.mjs \
  workers/phala-worker/src/platform/risk-observer.js \
  workers/phala-worker/src/platform/risk-observer.test.mjs \
  workers/phala-worker/src/platform/circuit-breaker.js \
  workers/phala-worker/src/platform/request-guards.js \
  apps/web/lib/provider-configs.ts \
  apps/web/lib/neo-control-plane.ts
git commit -m "feat: add policy engine and risk observer"
```

### Task 8: Web Runtime APIs and Operator Introspection

**Files:**

- Create: `apps/web/lib/workflow-runtime.ts`
- Create: `apps/web/__tests__/workflow-runtime.test.ts`
- Create: `apps/web/app/api/workflows/route.ts`
- Create: `apps/web/app/api/policies/route.ts`
- Modify: `apps/web/app/api/control-plane/jobs/[jobId]/route.ts`
- Modify: `apps/web/lib/control-plane.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { getPublicWorkflowCatalog } from '@/lib/workflow-runtime';

describe('workflow runtime catalog', () => {
  it('returns workflow and policy metadata without secrets', () => {
    const catalog = getPublicWorkflowCatalog();
    expect(catalog.workflows.some((item) => item.id === 'compute.execute')).toBe(true);
    expect('service_role_key' in catalog).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm --prefix apps/web run test:run -- __tests__/workflow-runtime.test.ts`
Expected: FAIL with missing module or missing `getPublicWorkflowCatalog`.

**Step 3: Write minimal implementation**

```ts
import runtimeCatalog from '../../../public/morpheus-runtime-catalog.json';

export function getPublicWorkflowCatalog() {
  return runtimeCatalog;
}
```

**Step 4: Run test to verify it passes**

Run: `npm --prefix apps/web run test:run -- __tests__/workflow-runtime.test.ts __tests__/control-plane.test.ts`
Expected: PASS and job lookups return workflow ids plus envelope metadata.

**Step 5: Commit**

```bash
git add apps/web/lib/workflow-runtime.ts \
  apps/web/__tests__/workflow-runtime.test.ts \
  apps/web/app/api/workflows/route.ts \
  apps/web/app/api/policies/route.ts \
  apps/web/app/api/control-plane/jobs/[jobId]/route.ts \
  apps/web/lib/control-plane.ts
git commit -m "feat: expose workflow and policy runtime apis"
```

### Task 9: Generated Runtime Artifacts for Platform and AA

**Files:**

- Create: `../neo-miniapps-platform/.worktrees/cross-repo-hardening/apps/shared/constants/generated-morpheus-runtime-catalog.ts`
- Modify: `../neo-miniapps-platform/.worktrees/cross-repo-hardening/apps/shared/constants/rpc.ts`
- Create: `../neo-miniapps-platform/.worktrees/cross-repo-hardening/platform/host-app/__tests__/lib/morpheus-runtime-catalog.test.ts`
- Create: `../neo-abstract-account/.worktrees/cross-repo-hardening/frontend/src/config/generatedMorpheusRuntimeCatalog.js`
- Modify: `../neo-abstract-account/.worktrees/cross-repo-hardening/frontend/src/config/runtimeConfig.js`
- Modify: `../neo-abstract-account/.worktrees/cross-repo-hardening/frontend/api/morpheus-base.js`
- Create: `../neo-abstract-account/.worktrees/cross-repo-hardening/frontend/tests/morpheusRuntimeCatalog.test.js`

**Step 1: Write the failing tests**

```ts
import { EXTERNAL_INTEGRATIONS } from '@/shared/constants/rpc';

test('platform runtime catalog exposes morpheus workflow metadata', () => {
  expect(EXTERNAL_INTEGRATIONS.testnet.morpheusWorkflowIds).toContain('automation.upkeep');
});
```

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { getRuntimeConfig } from '../src/config/runtimeConfig.js';

test('aa runtime config exposes paymaster workflow metadata', () => {
  const config = getRuntimeConfig({});
  assert.ok(config.morpheusWorkflowIds.includes('paymaster.authorize'));
});
```

**Step 2: Run tests to verify they fail**

Run: `npm --prefix ../neo-miniapps-platform/.worktrees/cross-repo-hardening/platform/host-app test -- --runInBand __tests__/lib/morpheus-runtime-catalog.test.ts`
Expected: FAIL because `morpheusWorkflowIds` is not exported yet.

Run: `node --test ../neo-abstract-account/.worktrees/cross-repo-hardening/frontend/tests/morpheusRuntimeCatalog.test.js`
Expected: FAIL because the generated AA runtime catalog file does not exist yet.

**Step 3: Write minimal implementation**

```ts
export const MORPHEUS_PUBLIC_RUNTIME_CATALOG = {
  envelope: { version: '2026-04-tee-v1' },
  workflows: [{ id: 'paymaster.authorize' }, { id: 'automation.upkeep' }],
};
```

```js
export function resolveMorpheusWorkflowIds() {
  return MORPHEUS_PUBLIC_RUNTIME_CATALOG.workflows.map((item) => item.id);
}
```

**Step 4: Run tests to verify they pass**

Run: `npm --prefix ../neo-miniapps-platform/.worktrees/cross-repo-hardening/platform/host-app test -- --runInBand __tests__/lib/morpheus-runtime-catalog.test.ts`
Expected: PASS with stable workflow ids in platform runtime config.

Run: `node --test ../neo-abstract-account/.worktrees/cross-repo-hardening/frontend/tests/morpheusRuntimeCatalog.test.js`
Expected: PASS with AA runtime config using generated Morpheus workflow metadata.

**Step 5: Commit**

```bash
git -C ../neo-miniapps-platform/.worktrees/cross-repo-hardening add \
  apps/shared/constants/generated-morpheus-runtime-catalog.ts \
  apps/shared/constants/rpc.ts \
  platform/host-app/__tests__/lib/morpheus-runtime-catalog.test.ts
git -C ../neo-miniapps-platform/.worktrees/cross-repo-hardening commit -m "feat: consume morpheus runtime catalog"

git -C ../neo-abstract-account/.worktrees/cross-repo-hardening add \
  frontend/src/config/generatedMorpheusRuntimeCatalog.js \
  frontend/src/config/runtimeConfig.js \
  frontend/api/morpheus-base.js \
  frontend/tests/morpheusRuntimeCatalog.test.js
git -C ../neo-abstract-account/.worktrees/cross-repo-hardening commit -m "feat: wire aa runtime to morpheus catalog"
```

### Task 10: Cross-Repo Validation, CI, and Docs

**Files:**

- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/run_workspace_live_validation.sh`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/WORKSPACE_CONTEXT.md`
- Modify: `../neo-miniapps-platform/.worktrees/cross-repo-hardening/deploy/scripts/verify_cross_repo_testnet.sh`
- Modify: `../neo-miniapps-platform/.worktrees/cross-repo-hardening/deploy/scripts/lib/ci_workflow.test.mjs`

**Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('ci covers runtime catalog validation', () => {
  const workflow = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.match(workflow, /export-public-runtime-catalog/);
  assert.match(workflow, /morpheus-runtime-catalog/);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test ../neo-miniapps-platform/.worktrees/cross-repo-hardening/deploy/scripts/lib/ci_workflow.test.mjs`
Expected: FAIL because CI does not yet verify the new runtime catalog/export step.

**Step 3: Write minimal implementation**

```yaml
- name: Verify Morpheus runtime artifacts
  run: |
    node ../neo-morpheus-oracle/scripts/export-public-runtime-catalog.mjs --output /tmp/morpheus-runtime-catalog.json
    test -s /tmp/morpheus-runtime-catalog.json
```

**Step 4: Run test to verify it passes**

Run: `node --test ../neo-miniapps-platform/.worktrees/cross-repo-hardening/deploy/scripts/lib/ci_workflow.test.mjs`
Expected: PASS and workspace live validation fails fast when generated artifacts drift.

**Step 5: Commit**

```bash
git add .github/workflows/ci.yml \
  scripts/run_workspace_live_validation.sh \
  docs/ARCHITECTURE.md \
  docs/WORKSPACE_CONTEXT.md
git commit -m "docs: validate runtime catalog across workspace"

git -C ../neo-miniapps-platform/.worktrees/cross-repo-hardening add \
  deploy/scripts/verify_cross_repo_testnet.sh \
  deploy/scripts/lib/ci_workflow.test.mjs
git -C ../neo-miniapps-platform/.worktrees/cross-repo-hardening commit -m "test: validate morpheus runtime catalog in ci"
```

## Full Verification Matrix

Run these after all tasks are complete:

```bash
cd /home/neo/git/neo-morpheus-oracle/.worktrees/cross-repo-hardening
node --test packages/shared/src/workflow-catalog.test.mjs
node --test scripts/export-public-runtime-catalog.test.mjs
node --test deploy/cloudflare/morpheus-control-plane/worker.test.mjs
node --test workers/morpheus-relayer/src/workflow-persistence.test.mjs
node --test workers/morpheus-relayer/src/automation-supervisor.test.mjs
node --test workers/phala-worker/src/platform/execution-plan.test.mjs
node --test workers/phala-worker/src/platform/policy-engine.test.mjs
node --test workers/phala-worker/src/platform/risk-observer.test.mjs
npm --prefix apps/web run test:run -- __tests__/workflow-runtime.test.ts __tests__/control-plane.test.ts __tests__/server-supabase.test.ts
npm run test:worker
npm run test:relayer
npm run test:control-plane
node scripts/check-web-consistency.mjs

cd /home/neo/git/neo-miniapps-platform/.worktrees/cross-repo-hardening
npm --prefix platform/host-app test -- --runInBand __tests__/lib/morpheus-runtime-catalog.test.ts __tests__/lib/external-integration-registry.test.ts
node --test deploy/scripts/lib/ci_workflow.test.mjs

cd /home/neo/git/neo-abstract-account/.worktrees/cross-repo-hardening/frontend
node --test tests/runtimeConfig.test.js tests/morpheusApiProxy.test.js tests/morpheusRegistryRuntime.test.js tests/morpheusRuntimeCatalog.test.js
```

## Rollout Order

1. Land Tasks 1-4 in `neo-morpheus-oracle` first so the workflow registry, public runtime catalog, and control-plane compatibility wrappers exist before consumer repos change.
2. Land Tasks 5-8 in `neo-morpheus-oracle` next so automation, TEE execution, policy, and operator APIs are stable behind the same workflow ids.
3. Land Task 9 in `neo-miniapps-platform` and `neo-abstract-account` after Morpheus exports are stable and checked in.
4. Land Task 10 last so CI and live validation treat the generated runtime catalog as a required production contract.

## External Product Lessons Being Applied

- Chainlink Runtime Environment is now the orchestration reference. Morpheus should mirror the typed workflow surface, not a route-by-route execution model.
- Chainlink Automation now points new automation builds toward CRE. Morpheus should treat automation as one workflow family under the same runtime contract, not a special-case lane.
- Chainlink Privacy keeps confidential work inside a trusted execution boundary. Morpheus should keep scheduling outside the TEE and only seal the execution plan plus confidential steps.
- Chainlink CCIP's risk management lesson is structural separation. Morpheus needs an observer and pause surface that is not identical to the primary execution path.

## Reference URLs

- `https://chain.link/chainlink-runtime-environment`
- `https://dev.chain.link/changelog/chainlink-runtime-environment-cre-is-live`
- `https://docs.chain.link/chainlink-automation`
- `https://docs.chain.link/chainlink-functions`
- `https://chain.link/cross-chain`
- `https://chain.link/datalink`
- `https://chain.link/automated-compliance-engine`
- `https://chain.link/privacy`
