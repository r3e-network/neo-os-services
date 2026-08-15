# Runtime API Live Validation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a reusable validator for Morpheus public runtime endpoints and make both repo-local and cross-repo live validation depend on it.

**Architecture:** Keep the public runtime contract checks in one small Node script instead of duplicating `curl` and `jq` assertions across shell scripts. The validator will fetch `/api/runtime/catalog` and `/api/runtime/status`, verify the public contract shape and key consistency, then the existing live-validation shell entrypoints will invoke it with the appropriate testnet public API base URL.

**Tech Stack:** Node.js ESM scripts, node:test, shell validation scripts, checked-in public runtime catalog contract.

### Task 1: Reusable Runtime API Validator

**Files:**

- Create: `scripts/check-public-runtime-api.mjs`
- Create: `scripts/check-public-runtime-api.test.mjs`

**Step 1: Write the failing test**

Add a script test that proves the validator:

- accepts a valid `catalog` + `status` pair
- rejects when `status.catalog.envelope.version` drifts from `catalog.envelope.version`
- rejects when `automation.upkeep` is missing from the catalog
- rejects when `status.runtime.status` is not one of the allowed states

**Step 2: Run test to verify it fails**

Run: `node --test scripts/check-public-runtime-api.test.mjs`
Expected: FAIL with missing module or missing validator exports.

**Step 3: Write minimal implementation**

Implement a validator module that:

- normalizes the base URL
- fetches `/api/runtime/catalog` and `/api/runtime/status`
- validates the expected public contract
- prints a small JSON summary on success

**Step 4: Run test to verify it passes**

Run: `node --test scripts/check-public-runtime-api.test.mjs`
Expected: PASS

**Step 5: Commit**

```bash
git add scripts/check-public-runtime-api.mjs scripts/check-public-runtime-api.test.mjs
git commit -m "feat: validate public runtime api contract"
```

### Task 2: Morpheus Live Validation Integration

**Files:**

- Modify: `scripts/run_live_testnet_validation.sh`

**Step 1: Write the failing test**

Keep the red/green proof in the Node validator test from Task 1. The shell integration should stay thin and use the already-tested validator.

**Step 2: Run test to verify it fails**

Run: `node --test scripts/check-public-runtime-api.test.mjs`
Expected: already red from Task 1 before implementation.

**Step 3: Write minimal implementation**

Call the validator from `scripts/run_live_testnet_validation.sh` before the existing control-plane/oracle smoke steps, using the testnet public API base URL from the checked-in network registry.

**Step 4: Run affected checks**

Run:

- `bash -n scripts/run_live_testnet_validation.sh`
- `node --test scripts/check-public-runtime-api.test.mjs`

Expected: PASS

**Step 5: Commit**

```bash
git add scripts/run_live_testnet_validation.sh
git commit -m "feat: validate runtime api during live checks"
```

### Task 3: Cross-Repo Validation Integration

**Files:**

- Modify: `/home/neo/git/neo-miniapps-platform/deploy/scripts/verify_cross_repo_testnet.sh`

**Step 1: Write the failing test**

Reuse the validator red/green proof rather than inventing a separate shell test harness.

**Step 2: Run test to verify it fails**

Run: `node --test scripts/check-public-runtime-api.test.mjs`
Expected: already covered in Task 1.

**Step 3: Write minimal implementation**

Invoke the same validator from the miniapps cross-repo testnet validator using the Morpheus testnet public API URL.

**Step 4: Run affected checks**

Run:

- `bash -n /home/neo/git/neo-miniapps-platform/deploy/scripts/verify_cross_repo_testnet.sh`
- `node --test scripts/check-public-runtime-api.test.mjs`

Expected: PASS

**Step 5: Commit**

```bash
git add /home/neo/git/neo-miniapps-platform/deploy/scripts/verify_cross_repo_testnet.sh
git commit -m "feat: enforce morpheus runtime api contract in cross-repo validation"
```
