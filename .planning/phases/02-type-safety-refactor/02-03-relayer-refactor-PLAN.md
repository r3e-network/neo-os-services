---
wave: 2
depends_on: ['02-01-supabase-typing-PLAN.md']
files_modified: []
autonomous: true
---

# Plan 02-03: Relayer Core Module Refactor

## Goal

Split the monolithic relayer modules (`fulfillment.js`, `neo-n3.js`) into smaller,
focused modules with clear interfaces, reducing regression risk and improving testability.

## Context

- `workers/morpheus-relayer/src/fulfillment.js` is ~1968 lines.
- `workers/morpheus-relayer/src/neo-n3.js` is ~1280 lines.
- `workers/morpheus-relayer/src/chain/feed-submit.js` is an example of the desired
  smaller-module pattern.

## Tasks

<task id="1" name="Extract fulfillment responsibilities">
Split `workers/morpheus-relayer/src/fulfillment.js` into:
- `fulfillment/executor.js` — run fulfillment transaction logic
- `fulfillment/classifier.js` — error classification (keep strings for now, but isolate)
- `fulfillment/coordinator.js` — high-level retry / dead-letter orchestration
- `fulfillment/index.js` — barrel re-export to preserve existing imports

<verify>
Original tests still import from `fulfillment.js` and pass. New tests for each
sub-module pass. Module count is at least 3, each < 600 lines.
</verify>
</task>

<task id="2" name="Extract Neo N3 chain responsibilities">
Split `workers/morpheus-relayer/src/neo-n3.js` into:
- `chain/neo-n3/rpc-manager.js` — URL list, promotion, health checks
- `chain/neo-n3/invocation-builder.js` — build and sign invocations
- `chain/neo-n3/submitter.js` — submit and poll transactions
- `chain/neo-n3/index.js` — barrel re-export

<verify>
Existing tests pass. New unit tests for RPC manager and submitter pass. Module
count is at least 3, each < 600 lines.
</verify>
</task>

<task id="3" name="Fix known races and fragility">
Fix the RPC URL promotion race in `rpc-manager.js` by snapshotting the URL list at
the start of a request. Ensure chain cursor checkpoint validation in `chain-cursor.js`
raises a hard error instead of silently resetting to genesis.

<verify>
Concurrent tests exercise RPC URL promotion without list mutation errors. Chain
cursor tests assert a thrown error on invalid checkpoint rather than silent reset.
</verify>
</task>

<task id="4" name="Update barrel exports and imports">
Make sure `workers/morpheus-relayer/src/index.js` or main entry points still resolve
all required functions. Run the relayer test suite end-to-end.

<verify>
`npm --prefix workers/morpheus-relayer test` passes.
</verify>
</task>

## must_haves

- [ ] `fulfillment.js` is refactored into focused sub-modules
- [ ] `neo-n3.js` is refactored into focused sub-modules
- [ ] RPC URL promotion race is fixed
- [ ] Chain cursor checkpoint invalidation raises an error
- [ ] All existing relayer tests pass
- [ ] New tests for extracted modules pass
