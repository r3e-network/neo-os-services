# Runtime Catalog Status Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a canonical public runtime catalog and runtime status API in `apps/web`, then wire the status and explorer surfaces to that contract.

**Architecture:** Keep the checked-in public runtime catalog as the static source of truth and expose it through a canonical `/api/runtime/catalog` route. Add a separate `/api/runtime/status` route that joins safe catalog metadata with live runtime health/info probes, preserving the Chainlink-style separation between static workflow topology and live execution health while keeping confidential execution inside the TEE.

**Tech Stack:** Next.js route handlers, TypeScript, Vitest, checked-in JSON catalog, existing `proxyToPhala` runtime proxy.

### Task 1: Public Runtime Catalog Summary Helpers

**Files:**

- Modify: `apps/web/lib/workflow-runtime.ts`
- Test: `apps/web/__tests__/workflow-runtime.test.ts`

**Step 1: Write the failing test**

Extend `workflow-runtime.test.ts` to assert that the public catalog exposes:

- `topology.execution === 'tee_confidential'`
- `risk.actions` includes `pause_workflow`
- `automation.triggerKinds` includes `interval`
- a stable runtime discovery link set for `catalog`, `workflows`, and `policies`

**Step 2: Run test to verify it fails**

Run: `npm --prefix apps/web test -- --runInBand __tests__/workflow-runtime.test.ts`
Expected: FAIL with missing runtime summary helper or missing link metadata.

**Step 3: Write minimal implementation**

Add a helper that projects the generated workflow catalog into a small runtime summary object with:

- envelope
- topology
- risk
- automation
- workflow ids/count
- public links

**Step 4: Run test to verify it passes**

Run: `npm --prefix apps/web test -- --runInBand __tests__/workflow-runtime.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/web/lib/workflow-runtime.ts apps/web/__tests__/workflow-runtime.test.ts
git commit -m "feat: add public runtime catalog summary"
```

### Task 2: Live Runtime Status Snapshot

**Files:**

- Create: `apps/web/lib/runtime-status.ts`
- Create: `apps/web/__tests__/runtime-status.test.ts`
- Create: `apps/web/app/api/runtime/catalog/route.ts`
- Create: `apps/web/app/api/runtime/status/route.ts`

**Step 1: Write the failing test**

Add `runtime-status.test.ts` to assert that:

- operational health + info probes produce `runtime.status === 'operational'`
- health success + info failure produces `runtime.status === 'degraded'`
- missing health produces `runtime.status === 'down'`
- runtime info summarizes `appId` and `composeHash` without depending on raw upstream payloads

**Step 2: Run test to verify it fails**

Run: `npm --prefix apps/web test -- --runInBand __tests__/runtime-status.test.ts`
Expected: FAIL with missing module or missing status builder.

**Step 3: Write minimal implementation**

Add:

- a pure status snapshot builder in `lib/runtime-status.ts`
- `/api/runtime/catalog` as the canonical route for the checked-in public catalog
- `/api/runtime/status` as the canonical live status projection using `proxyToPhala`

**Step 4: Run test to verify it passes**

Run: `npm --prefix apps/web test -- --runInBand __tests__/runtime-status.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/web/lib/runtime-status.ts \
  apps/web/__tests__/runtime-status.test.ts \
  apps/web/app/api/runtime/catalog/route.ts \
  apps/web/app/api/runtime/status/route.ts
git commit -m "feat: add public runtime status api"
```

### Task 3: Dashboard and Status Surface Adoption

**Files:**

- Modify: `apps/web/app/status/page.tsx`
- Modify: `apps/web/components/dashboard/OverviewTab.tsx`
- Modify: `apps/web/README.md`

**Step 1: Write the failing test**

Prefer extending `runtime-status.test.ts` with assertions for any new pure formatting helpers. Keep route/UI changes thin.

**Step 2: Run test to verify it fails**

Run: `npm --prefix apps/web test -- --runInBand __tests__/runtime-status.test.ts`
Expected: FAIL if new formatting/helper behavior is not implemented yet.

**Step 3: Write minimal implementation**

Switch the runtime monitor surfaces to:

- fetch `/api/runtime/status`
- show runtime topology/risk/automation metadata from the canonical contract
- keep `/api/runtime/info` and `/api/runtime/health` as compatibility endpoints
- document the new public routes in `apps/web/README.md`

**Step 4: Run tests and build**

Run:

- `npm --prefix apps/web test -- --runInBand __tests__/workflow-runtime.test.ts __tests__/runtime-status.test.ts`
- `npm --prefix apps/web run test:run`
- `npm --prefix apps/web run build`

Expected: PASS

**Step 5: Commit**

```bash
git add apps/web/app/status/page.tsx \
  apps/web/components/dashboard/OverviewTab.tsx \
  apps/web/README.md
git commit -m "feat: surface canonical runtime status"
```
