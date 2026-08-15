---
wave: 1
depends_on: []
files_modified: []
autonomous: true
---

# Plan 03-01: Error-Code Schema in packages/shared

## Goal

Define a shared, versioned error-code schema in `packages/shared` so workers, contracts, and relayers can return structured codes instead of free-text error messages. This is the foundation for making `classifyError` code-driven.

## Context

- `workers/morpheus-relayer/src/fulfillment/classifier.js` currently uses substring matching on error text.
- Worker payload errors, chain RPC errors, and contract revert reasons are all strings.
- A shared schema is needed to classify errors deterministically.

## Tasks

<task id="1" name="Design shared error-code schema">
Create `packages/shared/src/error-codes.js` (or `.ts` if shared is typed) defining:
- An `ErrorCode` enum/constant object with categories:
  - `TRANSIENT_NETWORK` — transport/RPC/timeout failures
  - `TRANSIENT_RATE_LIMIT` — explicit rate-limit or 429
  - `TRANSIENT_WORKER` — worker 5xx / transient compute failure
  - `PERMANENT_CONFIG` — bad contract hash, unauthorized, missing signer
  - `PERMANENT_ALREADY_FULFILLED` — duplicate / already settled
  - `PERMANENT_INVALID_REQUEST` — malformed payload, bad params
  - `UNKNOWN` — catch-all
- A `RelayerError` class (or object shape) carrying `{ code, message, cause?, retryable? }`.
- Helper `isRetryableErrorCode(code)`.
- Helper `wrapError(error, fallbackCode)` that extracts a known code from an Error object or assigns fallback.

<verify>
- File exists and exports the schema.
- `isRetryableErrorCode` returns correct boolean for each category.
- `wrapError` handles Error objects, strings, and arbitrary values.
</verify>
</task>

<task id="2" name="Map existing classifier outputs to new codes">
In `packages/shared/src/error-codes.js`, add a `classifyErrorMessage(message)` helper that maps the current regex/substring patterns from `classifier.js` to the new codes. This is intentionally a compatibility shim so `classifier.js` can migrate incrementally.

<verify>
- All existing classifier test cases from `fulfillment.test.mjs` still map to the same effective category via the new helper.
- New helper has unit tests in `packages/shared/src/error-codes.test.*` matching the existing test cases.
</verify>
</task>

<task id="3" name="Wire schema into relayer classifier">
Update `workers/morpheus-relayer/src/fulfillment/classifier.js` to import the shared schema and:
- Make `classifyError` return `{ code, category, retryable }` instead of a plain string label (or keep old string label for backward compat but add `.code` property).
- Prefer `error.code` if it is already a known `ErrorCode`, else fall back to `classifyErrorMessage(error.message)`.
- Keep existing tests passing by preserving the string category for consumers that read `classifyError(...).level`.

<verify>
- `npm --prefix workers/morpheus-relayer test` passes.
- `npm --prefix workers/morpheus-relayer run check` passes.
- New tests assert that injected `ErrorCode` objects are respected without string parsing.
</verify>
</task>

## must_haves

- [ ] Shared error-code schema exists in `packages/shared` and is exported.
- [ ] Backward-compatible classifier helper maps old strings to new codes.
- [ ] Relayer `classifyError` prefers structured codes over string parsing.
- [ ] All relayer tests pass.
