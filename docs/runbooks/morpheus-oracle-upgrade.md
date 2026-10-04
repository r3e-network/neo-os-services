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
# a node-side simulation of the planned call, and the rebuild chunk plan. Also archives the
# CURRENT on-chain state (the rollback artifact, see "Rollback") to
# private-backups/upgrades/morpheus-oracle.<network>.uc<N>.<timestamp>.*
node scripts/upgrade-morpheus-oracle.mjs --network testnet

# The same dry run with only read-only RPC methods (no state-changing method is simulated)
node scripts/upgrade-morpheus-oracle.mjs --network testnet --skip-simulation

# Send the planned step (admin key required; post-update reads run automatically)
UPGRADE_APPLY=1 MORPHEUS_ORACLE_ADMIN_WIF=... node scripts/upgrade-morpheus-oracle.mjs --network testnet

# Mainnet: name the node(s) yourself; twice means the two must agree before anything is planned
UPGRADE_APPLY=1 MORPHEUS_ORACLE_ADMIN_WIF=... node scripts/upgrade-morpheus-oracle.mjs --network mainnet \
  --rpc https://mainnet1.neo.coz.io:443 --rpc https://rpc10.n3.nspcc.ru:10331

# Another artifact (a rollback): --nef/--manifest instead of contracts/build
UPGRADE_APPLY=1 MORPHEUS_ORACLE_ADMIN_WIF=... node scripts/upgrade-morpheus-oracle.mjs --network testnet \
  --nef private-backups/upgrades/<archive>.nef --manifest private-backups/upgrades/<archive>.manifest.json

# Backfill the new reverse indexes in chunks, resuming from the on-chain cursor,
# then verify them via getstorage
REBUILD_APPLY=1 MORPHEUS_ORACLE_ADMIN_WIF=... node scripts/upgrade-morpheus-oracle.mjs --network testnet --batch-size 16
```

What the tool does about trust and environment:

| Concern             | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RPC endpoints       | `--rpc <url>` may be repeated. The first receives the transactions and answers every read; each further one is a read-only cross-check. Without `--rpc` the tool uses `NEO_RPC_URL` from the real environment, else two independent official public nodes (COZ and NeoSPCC, never the third-party indexer). A mainnet apply (`UPGRADE_APPLY=1` or `REBUILD_APPLY=1`) requires `--rpc` on the command line. |
| Agreement           | Every endpoint must report the `--network` magic (`getversion`) and the same `updatecounter`, NEF checksum and manifest for the kernel before anything is planned; any difference stops the run. A single mainnet endpoint is allowed and flagged as not cross-checked.                                                                                                                                    |
| Environment files   | Nothing is read from the checkout implicitly: neither `./.env` nor `deploy/nitro/morpheus.<network>.env`. A file is loaded only when named with `--env-file <path>` (repeatable; the real environment wins over a file and a later file over an earlier one). Node itself also recognises `--env-file` on the command line, so a missing file fails there (exit 9).                                        |
| Simulation          | The dry run asks the node to simulate the planned call (`invokefunction`; a node-side simulation, not a transaction: nothing is signed or broadcast and no state changes). `--skip-simulation` skips it, so only read-only methods are used; an apply refuses the flag because it simulates every call before signing it.                                                                                  |
| System fee          | A transaction carries the node's simulation of the call plus `--system-fee-margin <percent>` (default 10, `0` attaches the simulation exactly). The whole system fee is charged whether the script uses it or not, so the margin is real GAS; without it a simulation that under-reports FAULTs with "Insufficient GAS" and still burns the fee.                                                           |
| Absent storage keys | `getstorage` of a key that is not stored answers the JSON-RPC error -104 "Unknown storage item" on neo-go (0.121, 0.123) and C# Neo (3.10); older nodes answered null. The tool treats both as absent and fails on any other error.                                                                                                                                                                        |
| Post-update reads   | After an `update` (a rollback included) only the getters the ABI now on chain has are read, and booleans decode as booleans. Getters the target ABI lacks are listed under `not_in_target_abi`.                                                                                                                                                                                                            |

Signer: `MORPHEUS_ORACLE_ADMIN_WIF` (falls back to the repo's pinned `updater` role
key, read from the environment: name the file that holds it with `--env-file`). The script
refuses to send if the signer's script hash is not the on-chain
`admin()` - note the gate is the ADMIN, not the updater (on mainnet they differ:
admin `0x6d0656f6...`, updater `0x9fb28bda...`). Rebuild the local artifact first
(`contracts/build.sh`; the compiler is `$NCCS`, else `nccs` on `PATH`, else
`~/.dotnet/tools/nccs`, and must be 3.9.1); the script reads
`contracts/build/MorpheusOracle.{nef,manifest.json}`.

## Order of operations

1. **Testnet update** - `node scripts/upgrade-morpheus-oracle.mjs --network testnet`
   (dry run, confirm: `methods_added` includes `reservedRequestFees`,
   `withdrawableFees`, `rebuildIndexes`, `isIndexRebuildRequired`, and
   `indexRebuildCursor`; preview `state=HALT`; archive written), then
   re-run with `UPGRADE_APPLY=1`. The script verifies `updatecounter` incremented,
   the new checksum landed, the fee views answer, and a `getMiniApp` probe still
   returns the pre-update record. Only the getters of the ABI that is now on chain are
   read; `isIndexRebuildRequired` prints `true` right after this update (the lock is on).
2. **Examples smoke (testnet)** - `node scripts/smoke-oracle-n3.mjs` and the
   callback-boundary suites under `examples/scripts/` (`test-n3-examples.mjs`,
   `test-n3-aa-callback-replay-boundary.mjs`) to prove submit -> fulfill -> callback
   still round-trips on the upgraded kernel with the live relayer signer.
3. **RebuildIndexes backfill (testnet)** - re-run with `REBUILD_APPLY=1`. The update
   enables an index migration lock. For the generation deployed on testnet and mainnet
   (`updatecounter` 1, checksum 454480263), which already holds the callback index
   (prefix `0x27`, 3 entries on mainnet) and the account index (`0x28`), only the two
   calls that go through `PutMiniApp` assert the lock: until the cursor reaches the
   registry count, `registerMiniApp` and `configureMiniApp` fail with
   `"index rebuild required"`. `request()`, `submitMiniAppRequest`, fee deposits and
   `fulfilRequest` keep working while the lock is on (run in the VM against the live
   bytes; the two reverts, `submitMiniAppRequest` and a deposit were also run on a private
   neo-express chain). A generation older than that one, with no callback index yet,
   would also fail to resolve pre-existing integration contracts until the backfill,
   because the new index prefix would start empty. The owner clears the lock with one
   transaction, `rebuildIndexes(0, 5)` on mainnet (5 registered apps, default
   `--batch-size 16`), and the expected output is
   `3 callback mapping(s) correct; 2 legacy duplicate record(s) correctly skipped`.
   Backfill is chunked (`--batch-size`) and must advance contiguously. The script reads
   the on-chain cursor, so an interrupted run resumes at the first unfinished index. It
   then verifies every callback mapping on-chain via `getstorage` and refuses success
   while the lock remains.
4. **Mainnet update** - same two steps with `--network mainnet` and `--rpc` on the
   command line (twice, two independent nodes, to require that they agree). Triple-gate:
   dry run first, check the archive file exists, then `UPGRADE_APPLY=1`.
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
script reports the other two as "legacy duplicate record(s) correctly skipped" (the
whole line is `rebuild verified: 3 callback mapping(s) correct; 2 legacy duplicate
record(s) correctly skipped (first-wins)`). This is NOT an error. Post-upgrade
implications:

- `http-e2e`/`compute-e2e` can no longer reconfigure while KEEPING the shared
  callback (`"callback already registered"`); they must move to their own consumer
  contracts (they never received legacy-callback routing anyway).
- A duplicate that repoints away does NOT clear the winner's mapping (owner-checked
  delete; covered by `MorpheusOracleCallbackIndexTests`).
- Callback squatting is recoverable: the SYSTEM admin can always `configureMiniApp`
  a squatter's callback to null, releasing the mapping.

## Rollback

Rollback = update again with the PREVIOUS artifact. The script archives the current on-chain
state BEFORE every run (dry or apply) to `private-backups/upgrades/morpheus-oracle.<network>.uc<N>.<timestamp>.*`:

| File                         | What it is                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `.getcontractstate.raw.json` | the node's `getcontractstate` response exactly as received (the original bytes, escapes and key order included)  |
| `.contractstate.json`        | the same response parsed and pretty-printed                                                                      |
| `.nef`                       | the deployed NEF, reconstructed byte-exact and checksum-validated against the on-chain value                     |
| `.manifest.json`             | the deployed manifest in canonical form (keys sorted at every level, no whitespace): the file a rollback submits |
| `.manifest.served.json`      | the manifest as the serving node emitted it, in that node's key order (neo-go and C# nodes differ)               |
| `.rollback.json`             | the hashes below, the paths of the files above and the endpoint that served them                                 |

Which hash to compare. `scheduleUpdate` pins `sha256(nef || manifest text)` of the exact bytes
it is given, so the manifest text decides the hash, and a node re-serialises the manifest in
its own key order: the same contract hashes differently when a neo-go node or a C# node serves
it. `artifact_sha256` in `.rollback.json` is therefore computed over the canonical manifest, the
`.manifest.json` file: it is the same whichever node served it, it is what `scheduleUpdate` pins
when `.nef` and `.manifest.json` are submitted, and it is what `pending_upgrade.hashHex` and the
`upgrade scheduled` line show afterwards. Compare that one (and `nef_sha256`, `manifest_sha256`,
which are over the same files). `served_artifact_sha256` is over `.manifest.served.json`; it
depends on the serving node and is kept only to match figures published before the canonical
form existed. For the kernel deployed on 2026-10-04 (checksum 454480263): `nef_sha256`
`d88083e71d41489df127077ce6bb0c8fd973542fa2fcb7239b4ca1db5d4a8d8b`, `manifest_sha256`
`8761d3d4d61e7eebf5dccd5e789662d999de95c22f755b934264b8c4e146243d`, `artifact_sha256`
`7321bbabdb2337049b996febe98c63ad112d6a79dbff38c296212c83bd03109f`; `served_artifact_sha256` is
`191032dff57b5e6b870e36cfc90c53f9cb6d8f63360bc09688bc0a54b7acb5f5` from a neo-go node and
`85ba511568a32d296b91503584497f832c12e3033082280fdd00614ee58723f9` from a C# node. Always
schedule and execute with the same archived files: the kernel compares the hash of the bytes.

Once the timelocked generation is live, a rollback cannot be instant:

```sh
# 1. schedule the archived artifact (plan "schedule"; the tool reads the pinned hash back and
#    checks it equals the hash of the two files it was given: artifact_sha256 of .rollback.json)
UPGRADE_APPLY=1 MORPHEUS_ORACLE_ADMIN_WIF=... node scripts/upgrade-morpheus-oracle.mjs --network <network> \
  --nef private-backups/upgrades/morpheus-oracle.<network>.uc<N>.<ts>.nef \
  --manifest private-backups/upgrades/morpheus-oracle.<network>.uc<N>.<ts>.manifest.json
# 2. after 24 h, the same command executes it (plan "execute"); earlier runs plan "wait" and send nothing.
#    The run ends with the post-update reads of the ABI now on chain and exits 0.
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
