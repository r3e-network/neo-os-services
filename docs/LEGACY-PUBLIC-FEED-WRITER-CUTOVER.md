# Retired public feed writer cutover

The deployment source no longer ships `morpheus-public-feed-writer.service` or
`morpheus-public-feed-writer.timer`. They launched the untracked
`workers/nitro-worker/.neoos-live-feed-write.mjs --execute`. Their single exception
expired on 2026-10-21 and has been removed without renewal. Exact old bytes remain
under `scripts/fixtures/feed-writer-topology/retired-public-writer/` for tests only;
never install those fixtures.

This source change does not stop or disable installed systemd units and does not
establish an operational Rust feed writer for either network. Both reviewed Rust
unit variants conflict with the old service and timer names as a cutover safeguard;
`Conflicts=` does not remove installed files, reconcile transactions, or select
working network delivery contexts.

The deployment owner must complete and retain evidence for these steps:

1. Record installed unit contents, drop-ins, enablement, active state and all timer
   triggers for both old names. Preserve updater identity, status, pending signed
   transactions and durable journals; reconcile outstanding submissions against
   chain confirmation before any replacement may sign again.
2. Stop and disable the old timer first, then stop and disable the old service.
   Mask both names after archiving and removing any local unit files that would
   prevent masking. Reload systemd and verify both names are inactive, disabled or
   masked, and have no remaining boot links, drop-ins or external launchers.
   Do not delete journals or submit a replacement for an unresolved transaction.
3. Install only the reviewed Rust authority variant with the added conflicts.
   Validate explicit delivery contexts for each network and chain, immutable
   measured inputs, custody identity, feed mode, durable v2 state and lease
   ownership. One relayer configuration represents one network; these units do
   not establish a dual-network supervisor. Start the replacement only after the
   old writer is quiescent and its signed state is reconciled.
4. Read back installed unit bytes and mutual exclusion, unique authority per
   network/chain, and actual confirmed feed delivery for each intended context.
   Keep the old names masked across restart/boot verification. If admission or
   delivery fails, stop the candidate and hold publication; retain pending state
   and use the reviewed recovery procedure. Do not reinstall the untracked writer
   or renew its exhausted exception as a rollback.

`npm run check:production-topology` verifies the source tree only. Passing it is
not evidence of host cutover, measured artifact admission, or confirmed live writes.
