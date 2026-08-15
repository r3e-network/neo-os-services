# Plan 03 Summary: Error Handling & Observability

## Goal

Replace string/regex heuristic error classification with structured error codes,
introduce a shared structured logger, and remove silent error swallowing in the
Nitro key-store loader.

## Status

All Phase 3 plans completed and verified.

- [x] Plan 03-01: Shared error-code schema
- [x] Plan 03-02: Unified structured logger
- [x] Plan 03-03: Fix Nitro crypto empty catch

## Plan 03-01: Shared Error-Code Schema

### Changes

- Created `packages/shared/src/error-codes.js`
  - `ErrorCode` constants for retryable, terminal, settled, and unknown failure modes.
  - `RelayerError` class and `wrapError` helper for attaching codes to caught errors.
  - `isRetryableErrorCode`, `getErrorCodeLevel`, and `classifyErrorMessage` helpers.
- Created `packages/shared/src/error-codes.test.mjs` (27 assertions).
- Updated `packages/shared/package.json` to export `./error-codes` and fixed the `test` script to discover nested `.test.mjs` files.
- Re-exported the public API from `packages/shared/src/index.js`.
- Updated `workers/morpheus-relayer/src/fulfillment/classifier.js` so `classifyError` returns `{ level, code, retryable }`, preferring a known `err.code` and falling back to string classification.
- Updated `coordinator.js` and `dispatch.js` to consume the new object shape.
- Updated relayer tests to read `.level` instead of comparing the string directly.

### Verification

- `npm --prefix packages/shared test`: 94 tests, 0 failures
- `npm --prefix workers/morpheus-relayer test`: 434 tests, 0 failures
- `npm --prefix workers/morpheus-relayer run check`: pass

## Plan 03-02: Unified Structured Logger

### Changes

- Created `packages/shared/src/logger/index.js`
  - Dependency-free logger with `createLogger`, `createConsoleTransport`, `LEVELS`.
  - Levels: trace, debug, info, warn, error, fatal.
  - Output shape: `{ timestamp, namespace, service, level, message, ...metadata }`.
  - Supports `logger.info('msg', { ... })` and `logger.info({ ... }, 'msg')` signatures.
  - Supports `logger.child({ requestId, ... })`.
  - Built-in JSON and pretty formats; configurable redaction.
- Created `packages/shared/src/logger/index.d.ts` for TypeScript consumers.
- Created `packages/shared/src/logger/logger.test.mjs` (10 tests).
- Added `"./logger"` export to `packages/shared/package.json` and re-exported from the package root.
- Rewrote `workers/morpheus-relayer/src/logger.js` to wrap the shared logger while preserving Better Stack transport and legacy env vars.
- Switched `workers/morpheus-relayer/src/healthcheck.js` to the structured logger.
- Added example usage comments in `apps/web/app/api/cron/feed/route.ts` and `workers/nitro-worker/src/server.js`.

### Verification

- `npm --prefix packages/shared test`: 94 tests, 0 failures
- `npm --prefix workers/morpheus-relayer test`: 434 tests, 0 failures
- `npm --prefix apps/web run test:run`: 170 tests, 0 failures
- `npm --prefix workers/morpheus-relayer run check`: pass
- `grep -rn "console\." workers/morpheus-relayer/src` shows `console.*` only in `cli.js` (operator/CLI output).

## Plan 03-03: Fix Nitro Crypto Empty Catch

### Changes

- Updated `workers/nitro-worker/src/oracle/crypto.js`
  - The empty `catch {}` around the keystore read now distinguishes:
    - `ENOENT` → returns `undefined` (expected cold-start state).
    - `SyntaxError` → throws `keystore at <path> contains invalid JSON: ...`.
    - Any other error (e.g., `EACCES`) → re-thrown.
  - Added a FOOTGUN comment explaining why ENOENT is allowed and other errors must surface.
- Added `__loadStableOracleKeyMaterialForTests` export for tests.
- Added `workers/nitro-worker/src/oracle/crypto.test.mjs` tests:
  - Missing file returns `undefined`.
  - Corrupted JSON throws a descriptive error.
  - Permission error (`EACCES`) is re-thrown.

### Verification

- `npm --prefix workers/nitro-worker test`: 415 tests, 0 failures

## Next Steps

Phase 3 is complete. The next phase in the roadmap is Phase 4 (performance & scaling).
