# MorpheusOracle Kernel In-Place Upgrade (OR-D-01 + OR-D-03/N3)

Ships the prepared kernel generation onto the deployed hash
`0xf54d8584ef82315c1800373272ab08ae0db2d5ef` (same hash on testnet AND mainnet,
both `updatecounter=1` as of 2026-09-28) via the contract's admin-gated
`update(nefFile, manifest)` -> `ContractManagement.Update`. Storage persists across
the update; the contract hash does NOT change, so no client or relayer config needs
repointing.

Update gates. The deployed generation's `update` is not timelocked (its ABI has no
`scheduleUpdate`/`cancelUpdate`), so this upgrade applies in one transaction. The generation
it installs accepts `update` only after `scheduleUpdate(nef, manifest)` pinned
`sha256(nef || manifest)` and 24 h elapsed; every later update, a rollback included, takes that
path. The fee-consent fix that this generation carries (R-01), its owner steps, the testnet
rehearsal and the rollback are in `docs/security/ORACLE-INTEGRATION-WITNESS-20260928.md`.

What this generation added over the kernel deployed when this runbook was first written
(the live kernel has since gained `reservedRequestFees`, `withdrawableFees` and
`rebuildIndexes`; the diff against the live ABI as of 2026-09-28 is 29 methods added and
`setAdmin`, `setRuntimeEncryptionKey`, `setRuntimeVerificationPublicKey` removed, listed in the
security note above; the upgrade script prints the current diff):

| Change                                                                                      | Why                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reservedRequestFees` / `withdrawableFees` + reserve-gated `withdrawAccruedFees`            | The deployed kernel lets the admin withdraw fees that back pending requests, shrinking expiry refunds.                                                                                                                                                                      |
| O(1) callback reverse index + `rebuildIndexes(start, count)` backfill                       | The deployed kernel resolves `request`/`requestFromCallback` with an O(n) registry scan (per-request DoS as the registry grows).                                                                                                                                            |
| Callback-uniqueness assert in `PutMiniApp` (`"callback already registered"`)                | Without it the new O(1) index is last-write-wins: any account could register a fresh appId over an existing app's callback and repoint/brick its legacy request routing (the N3 half of OR-D-03; the EVM half is bytecode-frozen, see `docs/runbooks/callback-monitor.md`). |
| Upgrade-time index lock + resumable cursor (`isIndexRebuildRequired`, `indexRebuildCursor`) | The reverse index is empty immediately after an upgrade. Registration/configuration is paused until a sequential backfill completes, preventing callback squatting; backfill also repairs a pre-existing poisoned mapping by deriving the earliest registration.            |

Callback delivery is ABI-gated. The kernel checks `ContractManagement.HasMethod` for
`onMiniAppResult` with 8 parameters before dispatching the rich callback, and checks
`onOracleResult` with 5 parameters only when the rich method is absent. A missing method
is never discovered by deliberately invoking it, and a rich callback fault does not trigger
a second callback with potentially duplicated side effects. Inbox persistence remains the
canonical delivery record.

## Tooling

`scripts/upgrade-morpheus-oracle.mjs` - DRY RUN by default (read-only RPC). It reads the
deployed update gate and any pending schedule and plans one step: `update` (untimelocked
gate), `schedule`, `wait`, `execute`, or `cancel` (`--cancel`). A pending schedule for a
different artifact is refused unless `--reschedule` replaces it (the timelock restarts). The
planning logic is `scripts/lib-oracle-upgrade.mjs` (unit-tested).

```sh
# Preview: gate, deployed vs local checksum/method diff, sha256(nef || manifest), the plan,
# a test invoke of the planned call, and the rebuild chunk plan. Also archives the CURRENT
# on-chain NEF + compact manifest (the rollback artifact, with a .rollback.json naming its
# sha256) to private-backups/upgrades/morpheus-oracle.<network>.uc<N>.<timestamp>.*
node scripts/upgrade-morpheus-oracle.mjs --network testnet

# Send the planned step (admin key required; post-update reads run automatically)
UPGRADE_APPLY=1 MORPHEUS_ORACLE_ADMIN_WIF=... node scripts/upgrade-morpheus-oracle.mjs --network testnet

# Another artifact (a rollback): --nef/--manifest instead of contracts/build
UPGRADE_APPLY=1 MORPHEUS_ORACLE_ADMIN_WIF=... node scripts/upgrade-morpheus-oracle.mjs --network testnet \
  --nef private-backups/upgrades/<archive>.nef --manifest private-backups/upgrades/<archive>.manifest.json

# Backfill the new reverse indexes in chunks, resuming from the on-chain cursor,
# then verify them via getstorage
REBUILD_APPLY=1 MORPHEUS_ORACLE_ADMIN_WIF=... node scripts/upgrade-morpheus-oracle.mjs --network testnet --batch-size 16
```

Signer: `MORPHEUS_ORACLE_ADMIN_WIF` (falls back to the repo's pinned `updater` role
key). The script refuses to send if the signer's script hash is not the on-chain
`admin()` - note the gate is the ADMIN, not the updater (on mainnet they differ:
admin `0x6d0656f6...`, updater `0x9fb28bda...`). Rebuild the local artifact first
(`contracts/build.sh`); the script reads `contracts/build/MorpheusOracle.{nef,manifest.json}`.

## Order of operations

1. **Testnet update** - `node scripts/upgrade-morpheus-oracle.mjs --network testnet`
   (dry run, confirm: `methods_added` includes `reservedRequestFees`,
   `withdrawableFees`, `rebuildIndexes`, `isIndexRebuildRequired`, and
   `indexRebuildCursor`; preview `state=HALT`; archive written), then
   re-run with `UPGRADE_APPLY=1`. The script verifies `updatecounter` incremented,
   the new checksum landed, the fee views answer, and a `getMiniApp` probe still
   returns the pre-update record.
2. **Examples smoke (testnet)** - `node scripts/smoke-oracle-n3.mjs` and the
   callback-boundary suites under `examples/scripts/` (`test-n3-examples.mjs`,
   `test-n3-aa-callback-replay-boundary.mjs`) to prove submit -> fulfill -> callback
   still round-trips on the upgraded kernel with the live relayer signer.
3. **RebuildIndexes backfill (testnet)** - re-run with `REBUILD_APPLY=1`. The update
   enables an index migration lock. Until the cursor reaches the registry count,
   `registerMiniApp` and `configureMiniApp` fail with `"index rebuild required"`,
   and the legacy entry points (`request`, `requestFromCallback`,
   `queueAutomationRequest`) cannot resolve PRE-EXISTING integration contracts (the
   new index prefix starts empty) and directed fee deposits to pre-existing sponsors
   are rejected; `submitMiniAppRequest` by appId is unaffected. Backfill is chunked
   (`--batch-size`) and must advance contiguously. The script reads the on-chain cursor,
   so an interrupted run resumes at the first unfinished index. It then verifies every
   callback mapping on-chain via `getstorage` and refuses success while the lock remains.
4. **Mainnet update** - same two steps with `--network mainnet`. Triple-gate: dry
   run first, check the archive file exists, then `UPGRADE_APPLY=1`.
5. **Mainnet verification reads + backfill** - the apply path already reads
   `accruedRequestFees`/`reservedRequestFees`/`withdrawableFees`/`getMiniAppCount`
   and probes `getMiniApp`; then run `REBUILD_APPLY=1` (5 registered miniapps as of
   2026-06-11). Afterwards spot-check `withdrawAccruedFees` gating: a withdraw of
   more than `withdrawableFees()` must FAULT with
   `"amount exceeds withdrawable (unreserved) fees"`.

## Mainnet legacy duplicates (expected backfill output)

Three registered apps share one callback contract
(`vrf-e2e`, `http-e2e`, `compute-e2e` -> `0xe1226268f2fe08bea67fb29e1c8fda0d7c8e9844`).
The backfill is **first-wins** (registration order), mirroring the deployed O(n)
resolver's earliest-registered-wins semantics, so `vrf-e2e` keeps the mapping and the
script reports the other two as "legacy duplicate record(s) correctly skipped". This
is NOT an error. Post-upgrade implications:

- `http-e2e`/`compute-e2e` can no longer reconfigure while KEEPING the shared
  callback (`"callback already registered"`); they must move to their own consumer
  contracts (they never received legacy-callback routing anyway).
- A duplicate that repoints away does NOT clear the winner's mapping (owner-checked
  delete; covered by `MorpheusOracleCallbackIndexTests`).
- Callback squatting is recoverable: the SYSTEM admin can always `configureMiniApp`
  a squatter's callback to null, releasing the mapping.

## Rollback

Rollback = update again with the PREVIOUS artifact. The script archives the current on-chain
state BEFORE every run (dry or apply) to
`private-backups/upgrades/morpheus-oracle.<network>.uc<N>.<timestamp>.{nef,manifest.json,contractstate.json,rollback.json}` -
the `.nef` is reconstructed byte-exact (checksum-validated against the on-chain value) and the
manifest is the compact RPC JSON the rollback submits.

Once the timelocked generation is live, a rollback cannot be instant:

```sh
# 1. schedule the archived artifact (plan "schedule"; the tool verifies the pinned hash)
UPGRADE_APPLY=1 MORPHEUS_ORACLE_ADMIN_WIF=... node scripts/upgrade-morpheus-oracle.mjs --network <network> \
  --nef private-backups/upgrades/morpheus-oracle.<network>.uc<N>.<ts>.nef \
  --manifest private-backups/upgrades/morpheus-oracle.<network>.uc<N>.<ts>.manifest.json
# 2. after 24 h, the same command executes it (plan "execute"); earlier runs plan "wait" and send nothing
# 3. to withdraw a pending rollback: the same command with --cancel
```

Against an untimelocked generation the same command plans `update` and applies at once. Then
rebuild the current artifact with `contracts/build.sh`. Storage written by a newer generation
is left in place; the older code simply does not read the prefixes it never knew. Do NOT roll
back after fees have been reserved AND withdrawn under the new accounting without checking
`accruedRequestFees >= reservedRequestFees` first (the old code has no reserve and would allow
draining pending-request backing again - the original finding). Rehearse the full rollback
on testnet before mainnet depends on it (see the security note above).

## Storage compatibility (analysis summary)

The upgrade reuses the deployed storage layout unchanged: all pre-existing prefixes
(`0x01`-`0x25`) keep their key encodings and value formats. The new prefixes
(`0x26` reserved fees, `0x27` callback index keyed by the callback `UInt160` 20-byte
LE bytes -> appId string, `0x28` account membership, and `0x2D`/`0x2E` migration
required/cursor state) are populated by `_deploy(update=true)`, new submissions, and
`rebuildIndexes`. The callback-uniqueness assert adds only a read

- revert on the existing `0x27` prefix - no stored value is reinterpreted.
