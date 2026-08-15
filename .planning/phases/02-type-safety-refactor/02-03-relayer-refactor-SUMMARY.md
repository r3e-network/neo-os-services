# Plan 02-03 Summary: Relayer Core Module Refactor

## Goal

Split the monolithic relayer modules (`fulfillment.js`, `neo-n3.js`) into smaller,
focused modules with clear interfaces, and fix known races / fragility in the
chain-cursor and RPC URL promotion logic.

## Status

- [x] Task A (chain cursor checkpoint validation) completed.
- [x] Task B (neo-n3.js split + RPC URL promotion race fix) completed.
- [x] Task C (fulfillment.js split) completed.

All must_haves are complete. Tests and syntax checks pass.

## Task A: Chain Cursor Checkpoint Validation (completed)

### Changes

- `workers/morpheus-relayer/src/chain-cursor.js`
  - `resolveChainFromBlock` now throws a hard error when the persisted checkpoint is:
    - non-numeric / otherwise invalid (e.g. `NaN`, strings, values < -1)
    - greater than the current confirmed tip
  - Previously it silently reset `state[chain].last_block` to `null` and returned
    the configured genesis block.
  - The function still returns the configured start block for a missing checkpoint
    (cold start), which is the expected behavior.

- `workers/morpheus-relayer/relayer.test.mjs`
  - Updated the existing test that expected silent reset to instead assert a throw.
  - Added an explicit test for invalid checkpoints.

- `workers/morpheus-relayer/src/chain-cursor.test.mjs` (new)
  - Unit tests for `getRequestCursorFloor`, `pruneRetryQueueBelowRequestFloor`, and
    `resolveChainFromBlock` including the new hard-error paths.

### Verification

- `npm --prefix workers/morpheus-relayer test` passes: 431 tests, 0 failures.
- Existing callers of `resolveChainFromBlock` already wrap it in `try/catch` and log a
  warning, so the thrown error does not crash the relayer tick; it safely skips the
  discovery pass while still draining due retries.

## Task B: Neo N3 Chain Module Split (completed)

### Changes

- Created `workers/morpheus-relayer/src/chain/neo-n3/rpc-manager.js` (551 lines)
  - RPC URL management: `getNeoN3RpcUrls`, `promoteNeoN3RpcUrl`, `neoRpcCall`, `createNeoRpcError`.
  - Chain reads and scans: `getNeoN3LatestBlock`, `getNeoN3IndexedBlock`, `getNeoN3LatestRequestId`, `scanNeoN3OracleRequests*`, `buildNeoN3EventFromRequestRecord`, `buildNeoN3EventFromNotificationState`.
  - Decoding helpers and constants.
- Created `workers/morpheus-relayer/src/chain/neo-n3/invocation-builder.js` (376 lines)
  - Transaction construction, signing adapters, fee top-up, runtime-derived updater signing.
- Created `workers/morpheus-relayer/src/chain/neo-n3/submitter.js` (375 lines)
  - `fulfillNeoN3Request`, `queueNeoN3AutomationRequest`, `confirmNeoN3FulfillExecution`, `fetchNeoN3FeedRecord`.
- Created `workers/morpheus-relayer/src/chain/neo-n3/index.js` (22 lines)
  - Barrel re-export of the public API.
- Updated `workers/morpheus-relayer/src/neo-n3.js` to re-export from the new barrel.
- Updated external consumers (`relayer.js`, `automation.js`, `fulfillment.js`) and tests to import from the new barrel.

### RPC URL Promotion Race Fix

- `promoteNeoN3RpcUrl(config, rpcUrl, currentUrls)` now takes the ordered snapshot used by the caller.
- `neoRpcCall` passes its local `rpcUrls` snapshot to `promoteNeoN3RpcUrl`, removing the in-place re-read of `config.neo_n3.rpcUrls` during promotion.

### Verification

- `npm --prefix workers/morpheus-relayer run check` passes.
- `npm --prefix workers/morpheus-relayer test` passes: 431 tests, 0 failures.
- All new modules are under 600 lines.
- `grep -rn "from './neo-n3'" workers/morpheus-relayer/src` shows only the original barrel; no internal circular imports through the barrel.

## Task C: Fulfillment Module Split (completed)

### Changes

- Created focused sub-modules under `workers/morpheus-relayer/src/fulfillment/`:
  - `classifier.js` (172 lines): error classification helpers (`classifyError`, predicates, `trimOnchainErrorMessage`).
  - `signer.js` (216 lines): local Neo N3 signer, digest context, `signFulfillmentPayload`.
  - `enclave.js` (191 lines): compute-in-enclave `/oracle/fulfill` path.
  - `delivery.js` (274 lines): prepared fulfillment records, checkpointing, delivery, `finalizeFailedRequest`.
  - `dispatch.js` (372 lines): retry ceiling, dead-letter, `scheduleCallbackRetry`, terminal outcomes.
  - `executor.js` (454 lines): lane selection, worker invocation, `prepareOracleFulfillment`, `processOracleRequest`.
  - `coordinator.js` (418 lines): `processEvent` dispatcher.
  - `index.js` (57 lines): barrel re-export of the full public API.
- Updated `workers/morpheus-relayer/src/fulfillment.js` to a 4-line compatibility barrel re-exporting `./fulfillment/index.js`.
- Updated external consumers and tests to import from the new barrel where convenient.

### Verification

- `npm --prefix workers/morpheus-relayer run check` passes.
- `npm --prefix workers/morpheus-relayer test` passes: 431 tests, 0 failures, 53 suites.
- All fulfillment files are under 600 lines.
- `grep -rn "from './fulfillment" workers/morpheus-relayer/src/fulfillment` returns no internal barrel imports; sub-modules use direct relative imports.
- No circular dependencies among the new modules.
- Full public API preserved: `processEvent`, `processOracleRequest`, `finalizeFailedRequest`, `classifyError`, error predicates, retry helpers, signing helpers, automation helpers, test-only helpers, attestation re-exports, and `computeRetryDelayMs` / `normalizeErrorMessage` re-exports.

## Notes

- `relayer-analyzer` Explore agent provided the function boundaries and
  implementation-order recommendations used for this refactor.
- `neo-n3-splitter` and `fulfillment-splitter` software-engineer agents executed the
  splits under these specifications.
