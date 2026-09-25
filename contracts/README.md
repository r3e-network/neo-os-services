# Morpheus MiniApp OS Contracts

This directory now defines the Neo N3 on-chain kernel for the Morpheus `miniapp-os + miniapps` model.

The design goal is:

- system contracts own generic IO, request routing, callback delivery, fee accounting, and shared state
- miniapps register into the kernel instead of each deploying their own generic plumbing
- optional extension contracts remain possible, but they are adapters, not the default

## Included Contracts

### Neo N3

- `MorpheusOracle`
  - legacy deployment name retained for compatibility
  - now acts as the shared MiniApp OS kernel
  - owns miniapp registry, module registry, capability grants, async request queue, inbox delivery, shared fee credits, and generic app state
- `MorpheusDataFeed`
  - built-in shared numeric resource module
  - price feeds are the main use case, but the contract is framed as a reusable system registry for operator-maintained numeric snapshots
- `OracleCallbackConsumer`
  - optional external callback adapter
  - no longer required for normal miniapp integrations because the kernel inbox is canonical
- `NeoDIDRegistry`
  - specialized identity / nullifier verifier module
  - remains separate because its signature verification and replay constraints are domain-specific

## Kernel Model

The kernel contract is expected to own the generic platform surface:

1. `RegisterMiniApp(...)`
2. `RegisterSystemModule(...)`
3. `GrantModuleToMiniApp(...)`
4. `SubmitMiniAppRequest(...)`
5. `FulfillRequest(...)`
6. `GetInboxItem(...)`
7. `PutMiniAppState(...)`

That means:

- request/response flow is a kernel concern
- sponsorship / fee credits are a kernel concern
- callback persistence is a kernel concern
- common app state storage is a kernel concern
- miniapps focus on business configuration and business semantics

## Compatibility Layer

The old oracle-shaped entrypoints still exist in the kernel for migration:

- `Request(...)`
- `RequestFromCallback(...)`
- `QueueAutomationRequest(...)`
- `OracleEncryptionAlgorithm()`
- `OracleEncryptionPublicKey()`
- `OracleEncryptionKeyVersion()`
- `OracleVerificationPublicKey()`

These methods now map into the kernel model and should be treated as compatibility shims, not the preferred long-term API.

## Build

```bash
cd contracts
./build.sh
```

## Test

```bash
dotnet test __tests__/NeoContracts.Tests.csproj
```

## Next-upgrade notes (deployed N3 kernel `0xf54d8584`; tracked from the 2026-06-11 review)

The deployed kernel is upgradeable (admin-gated `Update`), but until the next upgrade ships
the following are live behaviors integrators must account for — and required fixes for the
next `ContractManagement.Update`:

- **Callback reverse-mapping uniqueness (OR-D-03)**: `PutMiniApp` (and `RebuildIndexes`) must
  assert `CallbackIndexMap[callbackContract]` is empty, already equals the appId, or maps to
  an app with the SAME admin before writing, or any account can repoint another app's callback
  routing (last-write-wins). The same-admin branch allows same-operator multi-tenant sharing
  (many appIds on one PlatformGame callback contract); the index stays first-wins so legacy
  routing keeps resolving to the earliest-registered app.
- **Upgrade-window callback protection (fixed in source; pending Update)**: `_deploy(update=true)`
  locks miniapp registration/configuration until `RebuildIndexes` advances a persisted,
  sequential cursor through the registry. This prevents a self-witnessing new app from claiming
  a legacy callback while the reverse index is empty. Backfill derives the earliest registration
  for each callback and repairs a mapping poisoned before this lock existed.
- **Rich `onMiniAppResult` dispatch (fixed in source; pending the next Update)**: the source
  now delivers `onMiniAppResult(requestId, appId, moduleId, operation, requester, success,
result, error)` and falls back to the legacy `onOracleResult(requestId, operation, success,
result, error)` for consumers that only implement the 5-arg adapter, so consumers built
  against `onMiniAppResult` receive the real appId + requester instead of recording
  appId="legacy"/requester=null. Both calls are best-effort (swallowed on failure). Until the
  next `ContractManagement.Update` deploys this, the LIVE kernel `0xf54d8584` still calls only
  `onOracleResult`.
- **`ExpireStaleRequest` writes no inbox item**: expiry refunds and emits
  `RequestExpired`/`MiniAppRequestCompleted` but stores no `InboxItem`, so inbox polling can
  never observe it. Consumers must treat `GetRequest().Status` as the source of truth and
  handle the Failed/expired state. Next upgrade: persist a failed inbox item on expiry.
- **Identifier charset**: `ValidateIdentifier` is length-only, but the relayer trims before
  hashing — whitespace-padded appId/moduleId/operation values produce a digest mismatch and
  can never be fulfilled (stall until expiry). Next upgrade: constrain identifiers to a safe
  charset (e.g. `[a-z0-9._-]`).
- **MiniApp fee sponsorship was default-open (SVC-E-8; fixed in source, pending Update)**:
  `IsRequesterSponsorable` returned true for any requester of an app whose admin had never
  configured an allowlist entry or a spend cap, so any witnessed account could drain a funded
  app's fee credit one `DEFAULT_REQUEST_FEE` at a time. The source now applies
  `DefaultSponsoredRequesterCap()` (default 1 GAS = 100 requests) per (app, requester) to
  unconfigured apps, reusing the existing spend ledger and its expiry-side release. New ABI:
  `DefaultSponsoredRequesterCap()`, `SetDefaultSponsoredRequesterCap(cap)` (platform admin;
  `0` closes open sponsorship entirely), `IsSponsorshipOpen(appId)` and
  `SetSponsorshipOpen(appId, open)` (app admin; `open=true` restores unbounded
  sponsor-everyone as an explicit, auditable choice). `IsSponsorshipGated` keeps its meaning.
  **Migration note**: the spend ledger has been recorded for ungated apps all along, so on
  upgrade a requester already past the default cap starts self-paying — raise the default (or
  set the app open) before the Update if any live app has heavy sponsored users.
- **Hot-path triple deserialize**: `SubmitMiniAppRequestInternal` loads + deserializes the
  MiniApp record three times (`ValidateRequestInputs` twice internally, then
  `RequireActiveMiniApp` again) and re-asserts `Active` redundantly. Next rebuild: have
  `ValidateRequestInputs` return the record (single load). Pure GAS savings.

### DataFeed signature migration

`MorpheusDataFeed.UpdateFeedSigned` now verifies a versioned `morpheus-datafeed-v2`
message. The message frames the pair, price, timestamp, round, attestation bytes,
source-set id, executing contract hash, and network magic. This closes provenance
substitution and cross-deployment replay, but it is an ABI-compatible behavior change:
the contract update and the Nitro worker must be rolled out as one change before an
oracle verification key is enabled. The existing deployed contract keeps its old
signature semantics until `ContractManagement.Update` succeeds; no live deployment is
claimed by this source change.

### DataFeed verification-key timelock and admin-reset provenance (SVC-E-3)

`SetOracleVerificationKey` / `ClearOracleVerificationKey` were admin-gated but immediate, so a
stolen admin key could remove the feed's signature second factor and anchor an arbitrary price
in the same transaction — while the sibling contracts already timelock exactly this authority
(`MorpheusOracle.ProposeRuntimeVerificationPublicKey`, `NeoDIDRegistry.ProposeVerifier`). Those
two methods are **replaced** (not shimmed) by the 24h propose/wait/execute lane in
`MorpheusDataFeed.Verifier.cs`:

- `ProposeOracleVerificationKey(publicKey)` / `ProposeClearOracleVerificationKey()` — admin,
  one pending change at a time
- `ExecuteOracleVerificationKeyChange()` — permissionless once matured, like `ExecuteAdminChange`
- `CancelOracleVerificationKeyChange()` — admin
- `PendingOracleVerificationKey()`, `PendingOracleVerificationKeyIsClear()`,
  `PendingOracleVerificationKeyChangeTime()` — read the pending change

`AdminResetFeed` stays immediate (feed-stall recovery must not wait 24h) but can no longer
masquerade as an attested update: a non-empty `attestationHash` argument now reverts with
"admin reset may not carry an attestation", the stored record carries an empty hash, and the
write emits a new `AdminFeedReset` event beside `FeedUpdated` so an indexer can tell a forced
write from an attested one. New storage prefixes `0x09`/`0x0A`; next free byte is `0x0B`.

No deploy tooling calls the removed methods; the change is ABI-breaking only for a caller that
used them directly. As with the signature migration above, no live deployment is claimed here.

### Live MorpheusOracle key-admin boundary

The reviewed source contract routes runtime encryption and verification key
changes through 24-hour propose/cancel/execute methods. The live N3 kernel at
`0xf54d8584` still exposes a 64-method legacy ABI without those methods, so its
admin-only `setOracleEncryptionKey` and `setOracleVerificationPublicKey`
operations remain immediate single-signature paths. Publisher scripts must
read the deployed ABI and refuse to propose or claim a delayed activation until
the governed contract update is deployed and read back. No live update is
claimed by this repository state.
