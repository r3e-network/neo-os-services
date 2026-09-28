# Oracle fee-consent hole on the integration and updater lanes (R-01)

Date: 2026-09-28
Contract: `MorpheusOracle` (MiniApp OS kernel), `contracts/MorpheusOracle/`
Severity: S0 (a third party's prepaid on-chain fee credit could be spent without its consent)
Register: `claudedocs/verification-20260928/REGISTER.md`, finding R-01
Status: fixed in source; the on-chain upgrade is an owner action (see "Owner deployment")

## Summary

The kernel charges a request fee to one account's prepaid credit (`feeCreditOf`). Two lanes
let the caller name that account without proving its consent:

- `submitMiniAppRequestFromIntegration(requester, …)` (and its alias `requestFromCallback`)
  checked only that the caller was the app's registered integration contract;
- `queueSystemRequest(requester, …)` (and its alias `queueAutomationRequest`) checked only the
  updater role.

When the app's fee payer did not cover the request, the fee fell back to the named requester's
own credit. App registration is permissionless and module grants are self-service, so the
integration-lane precondition (being some app's integration contract) is available to anyone.

The fix makes consent explicit. An account's credit is debited only when that account's
witness holds inside the kernel, when it is the app's own fee payer (which consented to fund
the app), when the app fee payer sponsors it under the sponsorship policy, or, for automation,
under the account's own signed per-job approval with a spend cap and an expiry. Anything else
reverts and leaves every balance untouched.

## Affected deployments

Read on 2026-09-28 with public read-only RPC (`getcontractstate`, `invokefunction` on `[Safe]`
getters, `findstorage`); no transaction was sent. The same bytecode is deployed on both
networks.

| Fact                                                 | mainnet                                                            | testnet                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| kernel hash                                          | `0xf54d8584ef82315c1800373272ab08ae0db2d5ef`                       | `0xf54d8584ef82315c1800373272ab08ae0db2d5ef`                       |
| contract id                                          | 603                                                                | 7508                                                               |
| `updatecounter`                                      | 1                                                                  | 1                                                                  |
| NEF checksum                                         | 454480263                                                          | 454480263                                                          |
| NEF file sha256 (rebuilt from the RPC `nef`)         | `d88083e71d41489df127077ce6bb0c8fd973542fa2fcb7239b4ca1db5d4a8d8b` | `d88083e71d41489df127077ce6bb0c8fd973542fa2fcb7239b4ca1db5d4a8d8b` |
| script sha256                                        | `a419d59d9c56e661f26d74f3f0b4917cd4ea05fb4c0dcb9951f4749589f09497` | `a419d59d9c56e661f26d74f3f0b4917cd4ea05fb4c0dcb9951f4749589f09497` |
| manifest sha256 (compact RPC JSON)                   | `f0cbf2363f2978f9b936c25d428dbdc8c1685526cb2db6775b84d178cb04b716` | `f0cbf2363f2978f9b936c25d428dbdc8c1685526cb2db6775b84d178cb04b716` |
| rollback artifact `sha256(nef ‖ manifest)`           | `191032dff57b5e6b870e36cfc90c53f9cb6d8f63360bc09688bc0a54b7acb5f5` | `191032dff57b5e6b870e36cfc90c53f9cb6d8f63360bc09688bc0a54b7acb5f5` |
| ABI methods / events                                 | 64 / 19                                                            | 64 / 19                                                            |
| update gate                                          | `update/2`, no `scheduleUpdate` / `cancelUpdate`                   | `update/2`, no `scheduleUpdate` / `cancelUpdate`                   |
| `admin()`                                            | `0x6d0656f6dd91469db1c90cc1e574380613f43738`                       | `0x6d0656f6dd91469db1c90cc1e574380613f43738`                       |
| `updater()`                                          | `0x9fb28bdacfaa7fcc0a4d660d0dc990b0e7d46118`                       | `0xe421999c396ee0249a8a8c9dd95bfbdaf55f8bf7`                       |
| `systemRequestFee()`                                 | 1000000 (0.01 GAS)                                                 | 1000000 (0.01 GAS)                                                 |
| `getMiniAppCount()` / `getTotalRequests()`           | 5 / 7                                                              | 1 / 6                                                              |
| funded credit accounts (prefix `0x19`), total credit | 1 account, 3000000 (0.03 GAS)                                      | 1 account, 94000000 (0.94 GAS)                                     |

The rollback artifact row is the value `scheduleUpdate` pins when the archived deployed NEF and
its compact manifest (what `scripts/upgrade-morpheus-oracle.mjs` writes to
`private-backups/upgrades/`) are scheduled for a rollback.

The deployed ABI exposes every affected entry point: `submitMiniAppRequestFromIntegration/5`,
`requestFromCallback/5`, `queueSystemRequest/5`, `queueAutomationRequest/5`,
`registerMiniApp/6`, `grantModuleToMiniApp/2`, `feeCreditOf/1`. The deployed generation is
older than `main` and its source is not in git history (the first review rebuilt the four
oracle source revisions, 4d2d136, c52837c, efbb49b and 9a03a41, and none matches checksum
454480263). The requester fallback described below is in every one of those revisions, and the
deployed ABI exposes the lanes that reach it, so the deployed generation is treated as
affected.

Exposure: one `systemRequestFee` per induced request; per account, bounded by its credit; in
aggregate, every account that ever deposits credit. The snapshot above is small, but the value
at risk grows with every deposit.

## Root cause

`MorpheusOracle.Requests.cs` resolved the payer in this order: the app fee payer when it held
enough credit and was willing to sponsor the requester, otherwise the requester itself. The
direct lane (`submitMiniAppRequest`, `request`) proves the requester's witness before it gets
there. The integration lane proved only `Runtime.CallingScriptHash == app.CallbackContract`,
and the updater lanes only the updater witness, so for those lanes the fallback charged an
account that never authorized the transaction.

Two further gaps were found while fixing it (review of the first patch):

- the relayer queues every automation execution through the updater lane naming the job owner,
  so requiring the owner's witness there would have silently ended automation self-pay;
- the app's own fee payer, named as the requester, was refused although it consented to fund
  the app when the app was registered or reconfigured.

## The fix

### Fee consent rules

`ResolveFeeBasis` (`MorpheusOracle.Requests.cs`) returns one of four bases, checked in order,
and reverts `requester witness required` when none applies:

| Basis            | Who pays      | Consent                                                                                                                                                                              |
| ---------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| app sponsor      | app fee payer | given when the app was registered or configured (`ValidateFeePayerAuthorization`); bounded per requester by the sponsorship policy (allowlist, per-requester cap, default cap, open) |
| requester        | the requester | its witness evaluated in the kernel, or it is this app's fee payer                                                                                                                   |
| automation spend | the requester | its signed approval for exactly this automation job, within the cap and before the expiry                                                                                            |
| none             | nobody        | no fee configured                                                                                                                                                                    |

"Witness evaluated in the kernel" means `Runtime.CheckWitness(requester)` inside the kernel.
Called through an integration contract, a `CalledByEntry` signature is valid only in that
contract, one frame above the kernel, so it is not consent. The requester can consent with a
signer scope that reaches the kernel: `CustomContracts` listing the kernel hash (optionally
with the integration contract), or `Global`.

### Automation self-pay: per-job approval

`MorpheusOracle.Automation.cs` preserves automation self-pay behind explicit consent:

- `approveAutomationSpend(registrationRequestId, cap, expiresAt)`: the job owner (the requester
  recorded on the job's `automation_register` request) signs a total spend cap and an expiry in
  `Runtime.Time` milliseconds for that one job; `cap = 0` revokes it. The recorded spend is kept
  across changes, so the cap bounds the job's total draw.
- `submitAutomationRegistration(appId, payload, cap, expiresAt)`: registers a job through the
  direct lane and records the approval in the same transaction.
- `queueAutomationExecution(registrationRequestId, requester, requestType, payload)`: the
  updater's lane for one execution. App and requester come from the on-chain registration; the
  named requester must match it (`automation requester mismatch`), so a stale or mis-keyed job
  record cannot be billed to another account's approval. The app fee payer pays first when it
  sponsors the requester; otherwise the approval must allow the fee
  (`automation spend not approved`, `automation spend approval expired`,
  `automation spend cap exceeded`). A failed registration and an execution that is itself an
  `automation.run` request are refused.
- `getAutomationSpendApproval(registrationRequestId)` reads the approval; the events
  `AutomationSpendApproved` and `AutomationSpendCharged` record every change and debit.
- `expireStaleRequest` returns an expired execution's fee to the job's cap, as it already did
  for the sponsorship ledger.

Cancelling a job off-chain does not touch its approval; the owner revokes it with `cap = 0`.
`queueSystemRequest` and `queueAutomationRequest` keep their ABI: the app fee payer, the app's
fee payer named as requester, or a requester that co-signed the transaction can still pay.

### Relayer and control plane

Both automation dispatchers pick the kernel lane from the deployed ABI
(`packages/shared/src/automation-supervisor.js`): with `queueAutomationExecution/4` present and
a job carrying its `registration_request_id`, they use it; otherwise the legacy lane. An
unreadable ABI fails the dispatch instead of guessing.

- `workers/morpheus-relayer` passes the job's registration id, and parks a job (status `error`)
  on a consent or credit revert instead of retrying it every tick.
- `apps/web` (`/api/internal/control-plane/automation-execute`) relays the chosen method through
  the worker's custody-signed txproxy.
- `workers/nitro-worker` allows `queueAutomationExecution` on the kernel in its txproxy
  allowlist.

### ABI and storage

Added: `approveAutomationSpend/3`, `submitAutomationRegistration/4`,
`queueAutomationExecution/4`, `getAutomationSpendApproval/1`, events `AutomationSpendApproved`
and `AutomationSpendCharged`. Storage prefixes `0x36` (approvals) and `0x37` (execution to
registration, for expiry refunds) are appended to the frozen map
(`MorpheusOracleStoragePrefixFreezeTests`). No existing method, event or prefix changed.

### Behaviour changes after the upgrade

- Integration contracts whose users pay their own fees need those users to sign with a scope
  that reaches the kernel, or the app fee payer must sponsor them.
- Automation job owners who pay their own executions must approve each job; until they do,
  their executions revert `automation spend not approved` and the dispatchers park the job.
  Jobs of apps whose fee payer sponsors the owner are unaffected.
- `docs/EXAMPLES.md` §23 describes the new fee model for integrators (English and Chinese), and
  `examples/scripts/test-n3-automation-deposit-exhaustion.mjs` now expects one queued execution
  under an approval, `request fee not paid` for the second approved job, and
  `automation spend not approved` for the unapproved one.

## Verification

Contract tests run the generated kernel artifact in `Neo.SmartContract.Testing`:

- `MorpheusOracleIntegrationWitnessTests` drives a real deployed intermediate contract
  (entry script → integration contract → kernel). Exploit proof for the integration lane: an
  app operator signing only as itself cannot charge a named account (direct and
  `requestFromCallback`); a `CalledByEntry` signature and one scoped to the integration
  contract alone are not consent; `CustomContracts` including the kernel and `Global` are; the
  app fee payer still sponsors, an exhausted sponsorship cap does not fall back to the
  requester, and the app fee payer named as requester pays.
- `MorpheusOracleAutomationSpendTests`: exploit proof for the updater lane
  (`queueSystemRequest` and `queueAutomationRequest` naming an account that did not sign), a
  co-signing requester and the fee payer as requester still pay, and the approval lane (cap,
  expiry, revocation, sponsorship first, expiry refund, owner mismatch, failed registration,
  control requests, updater only, same-transaction registration approval).

Each exploit test fails when its guard is reverted: restoring the old requester fallback in
`ResolveFeeBasis` makes the integration-lane and updater-lane exploit tests fail with the named
account charged; removing the fee-payer-as-requester branch fails the two fee-payer tests;
removing each approval check fails the test named after it.

Off-chain: `workers/morpheus-relayer/src/automation-queue-lane.test.mjs`,
`packages/shared/src/automation-supervisor.test.mjs`,
`apps/web/__tests__/control-plane-relay.test.ts`, the txproxy allowlist test in
`workers/nitro-worker/worker.test.mjs`, and for the upgrade tool
`scripts/lib-oracle-upgrade.test.mjs` and `scripts/upgrade-morpheus-oracle.test.mjs`.

## Fixed kernel build

Reproducible with `bash contracts/build.sh` (Neo.Compiler.CSharp 3.9.1):

| Artifact                                      | Value                                                              |
| --------------------------------------------- | ------------------------------------------------------------------ |
| `contracts/build/MorpheusOracle.nef` checksum | 647482271                                                          |
| NEF sha256                                    | `0772956ae9cd633449a7d5b0f08da645f2e5346a19fb5ca6ec81cd68f6cf97bb` |
| manifest sha256                               | `df2a91567baa634f3d9e7a556306b8d848cfa37e6d556071ac56a38ed24b9f65` |
| `sha256(nef ‖ manifest)`                      | `b10ebc23e8747f83b91f657051ecc8390dad7e9d93b798c7788064b37927fa03` |
| ABI methods / events                          | 90 / 29                                                            |

Against the deployed generation the upgrade adds 29 methods and 10 events and removes
`setAdmin/1`, `setRuntimeEncryptionKey/2` and `setRuntimeVerificationPublicKey/1`. Besides this
fix it lands the work already on `main`: the 24 h governance timelocks (admin rotation, runtime
key re-pointing, `scheduleUpdate`/`update`/`cancelUpdate`), SVC-E-8 bounded default
sponsorship, ABI-gated callback dispatch and the expiry inbox item. Review the method diff the
tool prints before applying.

## Owner deployment (no chain write was performed)

Every step that sends a transaction needs the `admin()` key above (same on both networks) and
is the owner's to run. The tool is `scripts/upgrade-morpheus-oracle.mjs`: dry run by default,
`UPGRADE_APPLY=1` sends the planned step, `REBUILD_APPLY=1` runs the index backfill.

### Update gates

- The deployed generation's ABI has `update/2` and neither `scheduleUpdate` nor
  `cancelUpdate`, so its admin-signed `update(nef, manifest)` is not timelocked. The tool plans
  `update` and test-invokes it with the admin as signer, so a HALT is seen before anything is
  sent.
- The fixed generation accepts `update` only after `scheduleUpdate(nef, manifest)`, 24 h, and
  the same bytes again (`sha256(nef ‖ manifest)` must match). Every update after this one,
  including a rollback, takes that path. The tool plans `schedule`, then `wait` (it refuses to
  send while the timelock runs), then `execute`; `--cancel` sends `cancelUpdate`, and a
  different pending artifact is refused unless `--reschedule` is given (which restarts the
  timelock).

### Preconditions

1. Deploy the relayer, the web control plane and the Nitro worker from this change first. They
   keep using the legacy lane until the kernel exposes `queueAutomationExecution/4`, then
   switch by themselves.
2. If the updater's custody key policy carries a contract-method whitelist, add
   `queueAutomationExecution` on the kernel (`docs/SIGNER_SERVICE.md` §4.2); otherwise custody
   refuses the new lane.
3. Tell integrators and automation job owners what changes (above). Owners of self-paid jobs
   can approve as soon as the upgrade lands; registrations made before it keep their request
   ids. `PlatformGame` in neo-os-contracts calls `requestFromCallback` and
   `submitMiniAppRequestFromIntegration` naming the player, so each app it serves needs a funded
   fee payer whose sponsorship policy covers its players (`setSponsorshipOpen`, an allowlist or
   per-player caps); neo-os-contracts also pins a copy of the kernel NEF for its real-kernel
   tests, which needs refreshing once this generation lands.
4. Build and check the artifact: `bash contracts/build.sh`, then confirm the checksum and
   sha256 values in "Fixed kernel build".

### Testnet rehearsal

1. Dry run: `node scripts/upgrade-morpheus-oracle.mjs --network testnet`. Expect
   `plan.action = "update"`, the method diff above, `update preview: state=HALT`, and an archive
   under `private-backups/upgrades/` whose `.rollback.json` names artifact
   `191032dff57b5e6b870e36cfc90c53f9cb6d8f63360bc09688bc0a54b7acb5f5`.
2. Apply: `UPGRADE_APPLY=1 MORPHEUS_ORACLE_ADMIN_WIF=… node scripts/upgrade-morpheus-oracle.mjs --network testnet`.
   The tool checks `updatecounter` 2 and checksum 647482271 on chain.
3. Backfill: `REBUILD_APPLY=1 MORPHEUS_ORACLE_ADMIN_WIF=… node scripts/upgrade-morpheus-oracle.mjs --network testnet`
   (the update re-arms the index rebuild lock because the registry is not empty).
4. Behaviour: with a test app whose fee payer holds no credit, a request through its
   integration contract naming an account that did not sign must FAULT
   `requester witness required` and leave `feeCreditOf` unchanged; the same request with the
   account signing `CustomContracts` [kernel] must HALT; a funded fee payer must still sponsor.
   Then run `node examples/scripts/test-n3-automation-deposit-exhaustion.mjs` (approval lane
   end to end, including the relayer) and the examples smoke from the upgrade runbook.
5. Rollback rehearsal, which proves the archive and the timelocked path before mainnet relies
   on them: schedule the archived deployed artifact with
   `UPGRADE_APPLY=1 … node scripts/upgrade-morpheus-oracle.mjs --network testnet --nef <archive>.nef --manifest <archive>.manifest.json`
   (plan `schedule`; the tool verifies the pinned hash is `191032df…`), wait 24 h, run the same
   command again (plan `execute`; `updatecounter` 3, checksum 454480263), confirm the old ABI,
   then upgrade again from `contracts/build` (plan `update`) and repeat the backfill.

### Mainnet

Repeat testnet steps 1 to 4 with `--network mainnet`: dry run, check the archive exists, apply,
backfill, behaviour checks. Pre-check and post-check the read-only facts in "Affected
deployments" (`updatecounter`, checksum, admin, updater, app count, accrued and reserved fees,
funded credit); the upgrade must not change any credit balance.

### Rollback

Rolling back reopens R-01, so it is for a fixed kernel that is broken, not for convenience, and
it cannot be instant: the fixed kernel's own timelock applies.

1. `UPGRADE_APPLY=1 MORPHEUS_ORACLE_ADMIN_WIF=… node scripts/upgrade-morpheus-oracle.mjs --network <net> --nef <archive>.nef --manifest <archive>.manifest.json`
   schedules the archived deployed artifact (`sha256` `191032df…`).
2. After 24 h, the same command executes the update. `updatecounter` increments and the checksum
   returns to 454480263.
3. `--cancel` withdraws a scheduled rollback before it executes.

Storage persists across the update. The deployed generation's source is not in git history,
so which of the new generation's prefixes (sponsorship `0x29` to `0x2C` and `0x35`, the index
lock `0x2D`/`0x2E`, governance `0x2F` to `0x34`, approvals `0x36`/`0x37`) it ignores cannot be
checked from source; the testnet rollback rehearsal is that check. Before a rollback, confirm
`accruedRequestFees >= reservedRequestFees` (the caveat in
`docs/runbooks/morpheus-oracle-upgrade.md`), and after it re-read the facts in "Affected
deployments". While a rollback is pending, the new generation's instant controls remain:
`setUpdater`, `setDefaultSponsoredRequesterCap`, `setRequestFee`.

## Read-only commands used

- `getcontractstate 0xf54d8584ef82315c1800373272ab08ae0db2d5ef` on `mainnet1.neo.coz.io` and
  `testnet1.neo.coz.io`: ABI, update gate, NEF, manifest, `updatecounter`.
- `invokefunction` on `admin`, `updater`, `systemRequestFee`, `getMiniAppCount`,
  `getTotalRequests`, `accruedRequestFees`, `reservedRequestFees`, `requestTTL`.
- `findstorage` prefix `0x19` (base64 `GQ==`): funded credit accounts, aggregated.

The NEF file sha256 and the rollback artifact hash were computed locally from the
`getcontractstate` response with `scripts/lib-oracle-upgrade.mjs` (`reconstructNefFile`
reproduces checksum 454480263).
