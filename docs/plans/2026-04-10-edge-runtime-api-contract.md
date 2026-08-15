# Edge Runtime API Contract Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Expose the canonical public Morpheus runtime catalog and runtime status contract on the actual public execution surface at `oracle.meshmini.app/<network>/api/runtime/*`.

**Architecture:** Keep `oracle.meshmini.app/<network>` as the canonical `public_api_url` because that is the production execution ingress already consumed cross-repo. Move the public runtime contract to the edge gateway by serving the checked-in runtime catalog there and building the live runtime status snapshot from origin `/health` and `/info` probes. Extract the catalog/status shaping logic into shared helpers so the web app and edge gateway stay contract-compatible instead of drifting.

**Tech Stack:** Cloudflare Worker, Node.js `node:test`, shared ESM helpers in `packages/shared`, existing public runtime catalog JSON, shell/script validation.

### Task 1: Capture the failing public edge behavior

**Files:**

- Create: `deploy/cloudflare/morpheus-edge-gateway/worker.test.mjs`
- Test: `deploy/cloudflare/morpheus-edge-gateway/worker.test.mjs`

**Step 1: Write the failing test**

Add tests that call the edge worker with:

- `GET https://oracle.meshmini.app/testnet/api/runtime/catalog`
- `GET https://oracle.meshmini.app/testnet/api/runtime/status`

Assert that:

- catalog returns `200`
- catalog contains the checked-in public envelope version and `automation.upkeep`
- status returns `200`
- status contains the public summary block plus runtime health/info derived from the origin probes

**Step 2: Run test to verify it fails**

Run: `node --test deploy/cloudflare/morpheus-edge-gateway/worker.test.mjs`

Expected: FAIL because the current worker proxies `/api/runtime/*` to the origin instead of serving the canonical public contract.

### Task 2: Extract shared public runtime helpers

**Files:**

- Create: `packages/shared/src/public-runtime.js`
- Create: `packages/shared/src/public-runtime.test.mjs`
- Modify: `packages/shared/src/index.js`

**Step 1: Write the failing test**

Add tests for helpers that:

- build the public runtime catalog summary from a catalog object
- build the runtime status snapshot from `health` and `info` probe payloads
- preserve the canonical discovery links (`/api/runtime/catalog`, `/api/workflows`, `/api/policies`)

**Step 2: Run test to verify it fails**

Run: `node --test packages/shared/src/public-runtime.test.mjs`

Expected: FAIL because the helper module does not exist yet.

**Step 3: Write minimal implementation**

Implement reusable JS helpers for:

- safe object/string coercion
- public catalog summary generation
- public runtime status snapshot generation

Export them through `packages/shared/src/index.js`.

**Step 4: Run test to verify it passes**

Run: `node --test packages/shared/src/public-runtime.test.mjs`

Expected: PASS.

### Task 3: Serve the runtime contract from the edge gateway

**Files:**

- Modify: `deploy/cloudflare/morpheus-edge-gateway/worker.mjs`
- Modify: `deploy/cloudflare/morpheus-edge-gateway/worker.test.mjs`

**Step 1: Write the failing test**

Extend the edge worker tests to assert:

- `/api/runtime/catalog` is served locally without an origin fetch
- `/api/runtime/status` probes origin `/health` and `/info` with the configured origin token
- cache headers remain safe (`no-store` for live status)

**Step 2: Run test to verify it fails**

Run: `node --test deploy/cloudflare/morpheus-edge-gateway/worker.test.mjs`

Expected: FAIL on the new assertions.

**Step 3: Write minimal implementation**

Add explicit handling in the worker for:

- `/api/runtime/catalog`
- `/api/runtime/status`
- optionally `/api/runtime/health` and `/api/runtime/info` for consistency

Use the shared helpers plus the checked-in runtime catalog JSON. Keep the rest of the gateway behavior unchanged.

**Step 4: Run test to verify it passes**

Run: `node --test deploy/cloudflare/morpheus-edge-gateway/worker.test.mjs`

Expected: PASS.

### Task 4: Align validation and monitoring with the real public surface

**Files:**

- Modify: `scripts/checkly-sync-api-checks.mjs`
- Modify: `scripts/betterstack-sync-monitors.mjs`
- Modify: `deploy/cloudflare/morpheus-edge-gateway/README.md`
- Modify: `docs/DEPLOYMENT.md`

**Step 1: Write the failing test**

Add or extend a small script-level regression test that asserts the public runtime contract is checked against `oracle.meshmini.app/<network>/api/runtime/*` as part of the runtime validation surface.

**Step 2: Run test to verify it fails**

Run: `node --test scripts/check-public-runtime-api.test.mjs`

Expected: FAIL only if the script contract or expected URLs are still inconsistent after route changes.

**Step 3: Write minimal implementation**

Update operator docs and synthetic monitoring definitions so the new public runtime endpoints are checked explicitly on the same host already published in network config.

**Step 4: Run test to verify it passes**

Run: `node --test scripts/check-public-runtime-api.test.mjs`

Expected: PASS.

### Task 5: Re-verify cross-repo behavior

**Files:**

- Modify if needed: `/home/neo/git/neo-miniapps-platform/deploy/scripts/verify_cross_repo_testnet.sh`

**Step 1: Run focused verification**

Run:

- `node --test packages/shared/src/public-runtime.test.mjs`
- `node --test deploy/cloudflare/morpheus-edge-gateway/worker.test.mjs`
- `node --test scripts/check-public-runtime-api.test.mjs`
- `npm run test:scripts`
- `bash -n scripts/run_live_testnet_validation.sh`
- `bash -n /home/neo/git/neo-miniapps-platform/deploy/scripts/verify_cross_repo_testnet.sh`

**Step 2: Run contract-level verification against the local public surface if feasible**

Run a local server or targeted harness and then:

- `node scripts/check-public-runtime-api.mjs <base-url>`

**Step 3: Commit**

```bash
git add packages/shared/src/public-runtime.js \
  packages/shared/src/public-runtime.test.mjs \
  packages/shared/src/index.js \
  deploy/cloudflare/morpheus-edge-gateway/worker.mjs \
  deploy/cloudflare/morpheus-edge-gateway/worker.test.mjs \
  scripts/checkly-sync-api-checks.mjs \
  scripts/betterstack-sync-monitors.mjs \
  deploy/cloudflare/morpheus-edge-gateway/README.md \
  docs/DEPLOYMENT.md
git commit -m "feat: publish runtime api contract on edge gateway"
```
