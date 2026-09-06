# Signer Service

Status: **the Rust custody contract and ownership boundary are implemented; deployment
and compatibility retirement remain phased.** Section [7](#7-migration) says exactly
what exists today and what still has to move.

`SIGNER_SERVICE_V2.md` is the security-hardening and Rust-migration specification.
This document remains the compatible v1 wire contract; v2 additions are additive and
must not weaken any rule below.

## 1. Purpose

The signer service is the only component in NeoOS allowed to hold an unlocked Neo N3
or NeoX private key, and the only component that decides whether a given key signs a
given intent. Every key is immutably bound to its chain family and chain identifier;
an N3/P-256 identity can never be reinterpreted as a NeoX/K-256 identity. Everything
else — the web host, the admin console, the explorer, the relayers, node-operations
tooling — asks it to sign and is told yes or no.

One sentence to test any new code against:

> If a component can produce a valid signature without this service evaluating a
> policy, the boundary is wrong.

## 2. Why a separate service, and why now

Two surfaces sign today, and neither can answer "should this key sign this?".

**`deploy/nitro/nitro-signer-server.mjs`, `POST /sign/payload`.** Accepts a
caller-chosen `key_role` and caller-supplied `data_hex`; the only validation on the
bytes is "lowercase hex, even length" (lines 248-250). One shared runtime token selects
any role, including updater and treasury roles. The maintainers already wrote down the
consequence: `deploy/feed-pusher/feed-pusher.mjs:350-352` explains that an earlier feed
path which sent `getMessageForSigning` bytes there was "turning the updater key into a
blind-signing oracle", and moved construction inside the enclave to escape it. Two
relayer call sites used this endpoint (`workers/morpheus-relayer/src/fulfillment/signer.js:186-194`,
`workers/morpheus-relayer/src/neo-n3.js:883-895`); both have since moved to the custody
service (§7 step 3), and the shim itself now refuses digest preimages such as
`getMessageForSigning` and requests with no resolvable role.

**`secure-sign-service-rs`** (separate repository). A consensus-only Rust signer with a
genuinely solid anti-equivocation policy (`secure-sign-core/src/neo/consensus.rs:104-149`
checks network allowlist, `dBFT` category, `valid_block_start == 0`, height versus
`valid_block_end`, sender length, exactly one signer, sender equals signer) and **no
transaction path at all** — the service is exactly `SignExtensiblePayload`, `SignBlock`,
`GetAccountStatus`. Two caveats verified in that repo: the policy is disabled on every
startup path except `with_vsock_consensus` (`secure-sign/src/startup.rs:42-66` gives
`consensus_network: None` for both `with_tcp` and `with_vsock`), and the account to sign
with is selected from a public key the caller names (`secure-sign-core/src/neo/sign.rs:110-125`),
so there is no caller identity.

Both problems have the same shape: **the key holder sits downstream of the decision, so
there is nowhere for the decision to live.** This service exists to be the place where
the decision lives.

## 3. Ownership matrix

| Repository / module           | Owns                                                                                                                            | Must not own                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `neo-os-services` (this repo) | **The signer service**: custody, key policy, caller registry, audit trail, the `/signer/api/v1/*` contract, deployment topology | Business logic of callers; transaction _construction_                                                        |
| `secure-sign-service-rs`      | Enclave backends: NEP-6 sealing, Nitro KMS attestable start, SGX, consensus policy, anti-equivocation journal                   | Caller identity and value policy (they belong to the service above); it may be wired in as a `vault` backend |
| `neo-os-web`                  | Host shell, MiniApp catalog, edge gateway, wallet/session boundary, deployment tooling                                          | Any private key. Signing requests go to the service                                                          |
| `neo-os-admin`                | MiniApp registry lifecycle, operator OIDC identity                                                                              | Keys. Its `NEO_OS_ADMIN_TRUSTED_SIGNING_KEYS` are publisher verification keys — verify only                  |
| `neo-os-explorer`             | Read APIs, relayer submission                                                                                                   | Keys; the `api/relayer.js` path must call the service rather than hold a relayer WIF                         |
| `neo-os-app`                  | User-held wallets, consent UI, `Global` witness scope refusal                                                                   | Service keys. It validates and prompts; it does not custody service keys                                     |
| `neo-os-contracts`            | On-chain contracts and build evidence                                                                                           | Anything signing at runtime                                                                                  |
| `neo-nexus`                   | **Consumer.** Operator console, config generation for runtimes, launch packs, endpoint pinning, health probes                   | Custody. It must not be able to open, derive, export or accept a private key                                 |

The `neo-nexus` row is now enforced in source: its `src/signer_client/` module
contains only wire types, endpoint validation, bearer/workload authentication,
and a redirect-disabled HTTP client. It has no P-256, WIF, NEP-2, AES sealing,
signer tables, or local fallback. Section 7 records the migration and its
cross-repository contract test.

## 4. Boundary rules

Three rules, each testable rather than aspirational.

### 4.1 Sign intent, never a digest

A request names an operation and carries bytes **the service parses itself**:
SerializeUnsigned transaction bytes, or consensus payload bytes. A request carrying a
32-byte digest hands interpretation of the signature to whoever asked for it — amount,
asset, recipient, witness scope and target contract are all invisible at that point, so
no policy can be written against it.

`data_hex` / `message_hex` shapes are not part of this contract, and are deprecated
where they exist today.

The one exception is deliberate and fenced: `POST /sign/raw` signs raw caller bytes
under a dedicated boundary switch, `allow_raw`, which defaults to closed, and requires
the route-specific caller capability `raw_sign`. It exists for dedicated enclave-host
role keys whose preimages are assembled inside the measured boundary.

NeoX oracle verification does **not** use that exception. The semantic
`POST /sign/eip191-fulfillment` route accepts the chain, oracle contract and structured
fulfillment fields, recomputes both the domain digest and EIP-191 message hash inside
custody, and returns a recoverable verifier signature. The caller cannot supply either
digest. This lane requires ordinary `sign` capability and a NeoX policy explicitly
bound to the exact chain id, a non-empty contract whitelist containing the oracle, and
a non-empty selector whitelist containing `fulfillRequest(uint256,bool,bytes,string,bytes)`.

Raw and semantic authority must never share a key. A raw caller can submit
`magicLE || SHA256(SerializeUnsigned)` and obtain exactly the ECDSA signature a Neo
transaction needs; cryptographic framing alone does **not** separate those domains.
Saving a policy therefore rejects `allow_raw` when any of `allow_consensus`,
`allow_transfer`, `allow_contract_call`, or `allow_global_scope` is enabled. Raw-only
keys are granted only to `raw_sign` callers; transaction/consensus keys are granted
only to `sign` callers. No amount, whitelist, fee, or window rule can make a mixed key
safe because `/sign/raw` cannot parse intent.

### 4.2 A key carries its own boundary and its own chain

Each custody key stores its policy — allowed operations, contract allow/deny lists,
exact contract-method allow/deny lists, asset allow/deny lists, recipient allow/deny
lists, global and per-asset single-amount and rolling-window ceilings, signer-count
ceiling per transaction, system-fee ceiling, network-fee ceiling, and a key-wide rolling
signature-count ceiling shared by transaction, consensus and raw routes — and its
network magic. Multiple windows may target one asset, and every matching limit must
pass. Fee ceilings use GAS fixed-8 raw units. Amounts and fees cross JSON as decimal
strings so JavaScript clients cannot round them.

- **The default is closed.** A key with no saved boundary signs nothing. An empty form
  save must mean "everything refused", never "no restrictions".
- **The magic is stored per key, not derived from a chain name.** A name-derived magic
  cannot distinguish two private networks that share a default, and one signature is
  then valid on both.

The rolling limit is a concurrency boundary, not merely an arithmetic check. All
signing decisions share one process-wide decision lock with key disable, caller
disable and policy mutation, so two requests cannot both read the same remaining
capacity. An allowed signature's audit row and all of its value-ledger rows are then
committed in one SQLite transaction before the witness leaves the service. If either
write fails, both roll back and no witness is returned. The production process also
holds one exclusive data-directory lease; multiple processes must not serve one vault.

For `dBFT` consensus, the service also parses the inner seven-byte
`message_type | block_index | validator_index | view_number` header and requires the
outer validity range to be `0..block_index`. Prepare-request, prepare-response and
commit signatures occupy a durable slot keyed by key, network magic, height, message
type, validator and view. An exact retry is idempotent; a different payload digest for
an occupied slot is refused as `consensus-equivocation`, including after restart.

### 4.3 A caller is a registered identity, not a shared secret

Each caller has exactly one authentication mode: a bearer token, or an Ed25519
workload identity. Each identity is granted a specific set of keys. Browser callers
declare an `Origin` (or `Referer` for navigations) that is checked against the origins
recorded for them; server-to-server callers record none and are refused if they present
one. Refusals are attributable: caller, key, reason code and the digest of what was
refused all reach the audit trail.

Workload callers use the audience-bound v2 assertion by default. They send
`X-NeoOS-Workload-Protocol: neoos-workload-v2`, `X-NeoOS-Audience`,
`X-NeoOS-Caller`, `X-NeoOS-Timestamp`, `X-NeoOS-Nonce`, and
`X-NeoOS-Signature`. The 64-byte Ed25519 signature is lowercase hex over this
UTF-8 message:

```text
neoos-workload-v2
audience:<canonical-signer-origin>
caller:<caller-id>
subject:<pinned-subject-or-empty>
timestamp:<canonical-unix-seconds>
nonce:<16-to-128-byte-base64url-alphabet>
method:<uppercase-http-method>
route:<exact-path-and-query>
body-sha256:<lowercase-hex-of-exact-request-body>
origin:<normalized-origin-or-empty>
```

The audience is one canonical HTTP(S) **origin**, not a general URL: user-info, path,
query, and fragment are forbidden and default ports/host case are normalized. The
service compares the signed value byte-for-byte with its configured audience. A proxy
therefore cannot route two signer instances by path under one audience; each custody
service needs its own origin. `SIGNER_SERVICE_WORKLOAD_AUDIENCE` sets that origin. It
defaults to the concrete listener origin, but is required for an unspecified bind such
as `0.0.0.0` and for a TLS/reverse-proxy public origin.

The audience identifies one logical custody security domain. Independent vaults or
replicas with independent nonce databases must never share it: use a distinct origin
for each, or keep one authoritative signer behind the origin. A rolling replacement
must preserve the signer database (including workload nonces and idempotency rows) and
drain the old process before the new one accepts traffic. In the Nitro custody image,
the caller-visible origin is baked into the measured EIF at build time; the default
matches the `127.0.0.1:8789` host bridge, while an external TLS origin must be passed as
`SIGNER_SERVICE_WORKLOAD_AUDIENCE` to `build-custody-eif.sh` and used verbatim by
NeoNexus.

The timestamp has a 60-second skew allowance. `(caller, nonce)` is inserted into a
durable replay table before the request can reach policy; reuse is
`workload-assertion-replayed`. Audience-less `neoos-workload-v1` is rejected by default.
`SIGNER_SERVICE_ALLOW_LEGACY_WORKLOAD_V1=true` temporarily accepts its original
four-header canonical form during a controlled migration; it must be removed after all
callers send v2. Sending bearer and workload credentials together is
`ambiguous-credential`, never a fallback from one mode to the other. Protocol and
audience failures use `workload-protocol-unsupported` and
`workload-audience-mismatch`.

Role names (`worker`, `relayer`, `updater`, `oracle_verifier`) are labels attached to
grants, not a containment mechanism. `config/signer-identities.json` maps all four
testnet roles to the same public key `02911ea2…` (`:3-26`; mainnet uses four distinct
keys, `:27-49`), while one shared bearer token selects among them — so on testnet role
separation has nothing to separate, and on mainnet the shared token still lets one
caller name any of the four roles. Authorization is keyed on caller→key grants instead,
which holds regardless of how many roles share a key.

Three requirements follow, and each is a checkable property of the service rather than a
recommendation:

- **An absent or unrecognized role is a refusal.** `nitro-signer-server.mjs:46-53`
  returns `'updater'` for anything it does not recognise, including the empty string a
  request with no role field produces, so a forgotten field yields a signature from the
  deployment/treasury key. The service's analogue of `key_id` has exactly one failure
  mode when it does not resolve: refuse.
- **One key per role per network.** Splitting testnet is a coordinated change, because
  the registry is generated outward — `neo-os-web/deploy/scripts/sync_morpheus_registry.mjs:58,167`
  emits `generated-morpheus-signer-registry.ts` into `neo-os-devpack` and
  `neo-os-miniapps`. Cost grows with delay.
- **Registry pinning is not a runtime switch.** `packages/shared/src/neo-signers-core.js:312-315`
  nulls the pinned identity when `MORPHEUS_ALLOW_UNPINNED_SIGNERS` is true, which skips
  every drift check (`:361-379` are all guarded on `pinned`) and then selects
  `primaryValid[0]` by env-var-name order (`:382-384`). The consequence is not that a
  wrong key gets accepted downstream — pinned verifiers reject it — but that the signer
  signs and reports `ok`, so the error surfaces on-chain instead of at the decision. A
  new service must not read that flag: an operator wanting to onboard an unregistered
  key edits the registry, and the registry is version-controlled.

The last one leaves today's bootstrap flow intact. `scripts/generate-nitro-signer-identity.mjs:54`
sets the flag because it mints a keypair that cannot be in the registry yet (`:45-46`) —
correct for that moment. What is missing today is any marker separating that file from a
runtime env file, and any step restoring `false` once the key is registered.

## 5. HTTP contract (v1)

Transport: loopback or an internal network. `X-Forwarded-*` is never used for
authorization.

Authentication headers: `Authorization: Bearer <caller token>`, plus `Origin` and/or
`Referer` when the caller is a browser.

| Method | Path                                     | Purpose                                                                                         |
| ------ | ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `POST` | `/signer/api/v1/sign/transaction`        | Sign SerializeUnsigned transaction bytes                                                        |
| `POST` | `/signer/api/v1/sign/consensus`          | Sign consensus payload bytes                                                                    |
| `POST` | `/signer/api/v1/sign/block`              | Validate and sign a structured Neo N3 block header through the durable consensus lane           |
| `POST` | `/signer/api/v1/sign/raw`                | Sign raw bytes (`allow_raw` keys only, §4.1)                                                    |
| `POST` | `/signer/api/v1/sign/eip191-fulfillment` | Sign a structured, chain/contract-bound NeoX fulfillment verifier digest                        |
| `GET`  | `/signer/api/v1/keys/{id}`               | Public identity of a key: address, script hash, verification script, whether signing is enabled |

The transaction route takes
`{"key_id": string, "unsigned_hex": string, "request_id"?: string,
"chain_family"?: "neo-n3" | "neox", "chain_id"?: integer}`. The family defaults
to `neo-n3` for compatible N3 clients; `chain_id` is required for NeoX and must match
both the EIP-1559 payload and the immutable key binding. The consensus route accepts
only `neo-n3` and no `chain_id`.
The block route accepts `key_id`, `network`, a compressed or uncompressed P-256
`public_key`, and a structured `{header, tx_hashes}` block. Hash strings are the
wire-order bytes represented as hex. The service recomputes the Neo double-SHA256
Merkle root, checks the one-byte `primary_index`, binds both network and public key
to the immutable custody record, and reserves one durable height-wide block slot
before opening key material. It never forwards a block through `/sign/raw`.
`/sign/raw` replaces `unsigned_hex` with `data_hex` and never parses the bytes — the
lane's only intent policy is the `allow_raw` switch (§4.1). A request id is
caller-scoped and idempotent: an exact retry returns the stored witness without charging
limits again; changed bytes, route, or key under the same id answer
`request-id-conflict` (`409`).

The EIP-191 fulfillment route takes this closed semantic shape (unknown fields are
rejected):

```json
{
  "key_id": "neox-verifier-key",
  "request_id": "relayer:neox:42",
  "chain_id": 12227332,
  "oracle_contract": "0x1111111111111111111111111111111111111111",
  "fulfillment": {
    "request_id": "42",
    "app_id": "price-oracle",
    "module_id": "http",
    "operation": "get",
    "success": true,
    "error": ""
  },
  "result_bytes_hex": "0x7b7d"
}
```

Its success body contains `digest`, the EIP-191 `message_hash`, a 65-byte
`signature` (`r || s || v`, with `v` 27 or 28), `public_key`, `address`, `chain_id`,
and the normalized `oracle_contract`. The caller must recompute the digest/message hash
and recover the returned identity before placing the signature in updater calldata.

**Success** — one shape for every allowed signature:

```json
{
  "allowed": true,
  "key_id": "…",
  "script_hash": "…",
  "address": "…",
  "digest": "sha256 of the signed bytes (the tx id for a transaction)",
  "invocation_script": "0c40<64B r||s>",
  "verification_script": "0c21<33B>4156e7b327"
}
```

For Neo N3 the caller assembles the witness itself; the service neither builds nor
broadcasts transactions. A NeoX success additionally returns `"chain_family": "neox"`
and the complete EIP-1559 transaction as `"signed_transaction": "0x02…"`.
`"signature_hex"` currently repeats that complete transaction as a deprecated
compatibility alias. NeoX invocation and verification scripts are empty because they
are N3 witness concepts; its `digest` is the Keccak-256 hash of the complete signed
transaction.

`/sign/raw` answers the same envelope plus two fields the raw caller verifies against
without rebuilding a witness: `"signature": "<64B r||s hex>"` and
`"public_key": "<33B hex>"`, sliced out of the pinned invocation and verification
scripts. Its `digest` is `sha256(data)` in natural byte order — the order every
verifier computes it in — not the explorer order a transaction id displays in.

**Refusal** — every denial, including authentication failures, uses one shape:

```json
{ "allowed": false, "code": "asset-not-whitelisted", "message": "…" }
```

Two audiences, deliberately split: a bounded `detail` string (≤512 bytes, hashes and
amounts only, never key material) is stored in the audit row and **never serialized into
the body of a refusal**. A client sees a code and a sentence; an operator sees the
specifics — and the only route that serves them is `GET /audit` (§5.1), which needs
`admin` and a whole-vault grant, so the specifics are reachable only by a caller already
entitled to read every row.

Status codes: `403` for every denial of an intent (`Denied` outcome), `400` for
`signer-transaction-unparsable` / `signer-script-unparsable` /
`signer-payload-unparsable` / `signer-unsigned-hex-unreadable` /
`signer-request-unreadable` / `signer-admin-request-invalid`, `404` for
`signer-key-unknown`, `signer-caller-unknown` and `signer-route-unknown`, `413` for
`signer-request-too-large`, `503` plus `Retry-After: 1` for `signer-service-busy`,
and `500` otherwise — which in practice means `signer-service-failed`.

Two codes are matched before their audit outcome is consulted, and the disagreement is
deliberate rather than an oversight in the table above. `signer-transaction-unparsable`
records `Failed` but answers `400`: the request was undeliverable, and the caller's next
move is to fix the bytes, not to wait for us. `signer-key-unknown` records `Failed` but
answers `404`: what a caller needs to branch on is that the id is not here, and the
signing path and the management path agree on that code precisely so neither can be used
to classify the other's ids.

### Reason codes

Transport layer, five codes for requests that never reached a decision:
`signer-request-unreadable` (a body that is not JSON, or a field whose value is not what
§5 says it is — the message names the caller's own field, which is the useful half, and
never quotes the input, because on `/keys/import` the input is a private key),
`signer-request-too-large`, `signer-route-unknown` (an unmatched path answers in the
refusal shape, so nothing this service sends makes a client guess whether it is talking
JSON), `signer-service-busy` (the process-wide custody budget is occupied; a fixed `503`
and `Retry-After: 1` reveal neither the route nor the live count), and
`signer-service-failed` (the store refused a read, a write or the clock; the message is
fixed and the specifics go to an audit row the transport writes itself, since the service
that would have recorded them never got that far).

The first four are answered without authenticating the caller and write no audit row.
That is safe because the first three describe only the caller's own bytes or URL, while
the fourth exposes only temporary process availability — never a vault fact, route, limit,
or live count. No pre-authentication failure becomes the one thing on this service that
answers in `text/plain`.

Access layer: `missing-token`, `unknown-token`, `caller-disabled`, `origin-required`,
`origin-not-allowed`, `origin-unexpected`, `key-not-granted`, and `admin-capability-missing`
— the last one covering both directions of a capability mismatch (§5.1), so no route can
be used to classify a bearer string that was not issued for it.

Workload additions are `ambiguous-credential`, `workload-assertion-malformed`,
`unknown-workload`, `workload-assertion-stale`, `workload-signature-invalid`,
`workload-protocol-unsupported`, `workload-audience-mismatch`, and
`workload-assertion-replayed`.

`signer-admin-request-invalid` is the one code on the management surface whose `message` is
specific rather than generic, and the exception is deliberate: `guard_admin` runs before the
request body is read, so nothing reaches that constructor without already holding `admin` and
a whole-vault grant. Whoever is on the receiving end of it is the operator who can act on it.
It is still never the caller's own input echoed back — a rejected private key string is a
secret, and it appears in neither the message nor the stored detail.

Decision guards: `signer-key-disabled`, `signer-custody-mismatch`,
`signer-public-key-unusable`, `consensus-equivocation`.

Policy layer, 24 codes: `consensus-forbidden`, `consensus-category-forbidden`,
`consensus-sender-mismatch`, `transfer-forbidden`, `contract-call-forbidden`,
`not-a-signer`, `global-scope-forbidden`, `delegation-missing`, `contract-blacklisted`,
`contract-not-whitelisted`, `contract-method-blacklisted`,
`contract-method-not-whitelisted`, `asset-blacklisted`, `asset-not-whitelisted`,
`recipient-blacklisted`, `recipient-not-whitelisted`, `source-mismatch`,
`negative-amount`, `single-amount-exceeded`, `window-amount-exceeded`,
`too-many-signers`, `system-fee-exceeded`, `network-fee-exceeded`, `raw-forbidden`.

Codes are stable wire vocabulary. Renaming one is a breaking change; adding one is not.

### 5.1 Management API (v1)

The service owns this surface so a client can configure custody without
reimplementing it. `neo-nexus` exposes the non-secret subset — enclave-born key
generation, boundary editing, caller provisioning and audit — behind its own
operator session. Secret import and `/provision` remain direct signer
ceremonies. Each route below maps 1:1 onto a method that already exists on
`SignerService`; nothing here is new behaviour, only a transport for it.

| Method   | Path                                 | Service method                                              |
| -------- | ------------------------------------ | ----------------------------------------------------------- |
| `POST`   | `/signer/api/v1/keys`                | `generate_key_for_chain(label, network, family, id?)`       |
| `POST`   | `/signer/api/v1/keys/import`         | `import_key_for_chain(label, network, family, id?, key)`    |
| `POST`   | `/signer/api/v1/keys/import-nep2`    | `import_nep2_key(label, network, magic?, nep2, passphrase)` |
| `GET`    | `/signer/api/v1/keys`                | `list_keys` — every key's `KeyPublicInfo`                   |
| `POST`   | `/signer/api/v1/keys/{id}/state`     | `set_key_disabled` — the one-click disable                  |
| `POST`   | `/signer/api/v1/keys/{id}/policy`    | `save_policy` (blank means everything closed, §4.2)         |
| `GET`    | `/signer/api/v1/keys/{id}/policy`    | `key_detail` — the boundary as it was stored, normalized    |
| `DELETE` | `/signer/api/v1/keys/{id}`           | `delete_key`                                                |
| `POST`   | `/signer/api/v1/callers`             | `create_caller(label, grant, capabilities, origins)`        |
| `POST`   | `/signer/api/v1/callers/workload`    | `create_workload_caller(..., Ed25519 public key, subject?)` |
| `GET`    | `/signer/api/v1/callers`             | `list_callers` — `CallerInfo`, digest excluded              |
| `POST`   | `/signer/api/v1/callers/{id}/rotate` | `rotate_caller_token`                                       |
| `POST`   | `/signer/api/v1/callers/{id}/state`  | `set_caller_disabled`                                       |
| `DELETE` | `/signer/api/v1/callers/{id}`        | `delete_caller`                                             |
| `GET`    | `/signer/api/v1/audit`               | `list_audit` — newest first, optionally filtered by key     |

Generated and raw-imported keys accept `chain_family` (`neo-n3` by default) and the
family-specific identifier. `network_magic` is valid only for Neo N3; absent means the
canonical magic for `network`. `chain_id` is valid only for NeoX; public networks accept
only the published chain id (mainnet `47763`, testnet `12227332`) while a non-zero private
chain id may be supplied. NEP-2 import remains Neo N3-only. Every key response exposes
`chain_family`, `chain_id`, `public_key`, `address`, and the compatibility `script_hash`;
NeoX `public_key` is compressed secp256k1 and its `address` is the natural-order EVM
address. The stored identifier rides back on every key body so an operator and client can
confirm what signatures commit to.

`GET /keys/{id}/policy` is a different path from `GET /keys/{id}` (§5) because the two are
guarded differently and return different things: the identity read is answered for a caller
holding `sign` and a granted key, the boundary read needs `admin`. Reusing one path for two
guards is how a route ends up answering whichever check happens to be reached first.

The rules that hold it together:

- **One caller table with capabilities, not a second auth system.** A caller record carries
  a capability set naming **exactly one** of `sign`, `raw_sign`, or `admin`.
  `POST /callers` refuses an
  empty set, a set naming both, and an unknown name — all before a token is minted, so a
  rejected request cannot leak a credential into existence. Two parallel credential stores is
  how one of them stops being checked — which is the shape of F-9's problem, restated before
  it can recur here.
- **Admin credentials cannot sign; signing credentials cannot administer.** Either
  mismatch refuses with `<capability>-capability-missing` — including an admin token used
  on a sign route, which must not be disguised as `signer-key-unknown`. A missing capability
  and a missing key are different operator actions, and collapsing them costs an
  afternoon of guessing per incident. This is also why the operator console holds only an
  admin token: compromised, it cannot become a signing oracle.
- **A request that names no key needs the whole vault.** Listing keys, listing callers,
  creating a caller or a key all reach rows the caller did not name, so `KeyGrant::Only`
  cannot answer them: they require `KeyGrant::Any` and refuse with `key-not-granted`.
  A caller scoped to one key can administer that key and nothing else — which is what
  makes a per-integration admin credential safe to hand out.
- **Capabilities are chosen at creation and never edited.** The mutation surface is the
  token (rotate), the switch (disable) and the grave (delete). Escalating a caller means
  deleting it and creating a new one, so the act has its own audit row and its own token;
  rotation deliberately changes the credential and nothing else, so a leaked token can be
  replaced without a grant ceremony.
- **The first admin credential has no route.** `provision_admin_caller` is a library call
  the operator runs against the data directory, not an endpoint: an HTTP path that could
  mint the first admin would be an HTTP path that mints admins forever. Its only caller is
  the process's `provision-admin <label>` mode
  (`workers/neo-signer/src/bin/signer_service.rs`), which writes the token to stdout and
  every word of explanation to stderr, so it can be piped into a secret manager without the
  secret ever becoming a command-line argument another user can read. It refuses when a
  caller holding `admin` already exists, and it grants `admin` and the whole vault — never
  `sign`. Every deployment therefore has exactly one credential nobody had to authenticate
  to obtain; its audit row is written against the new caller's own id, which is the whole
  sense in which it sits outside the trail.
- **Secret material crosses the boundary once, and only in a POST body.** A created or
  rotated caller token appears in exactly one response — never in a list, never in a URL,
  never in a log (the signer request path contains no logging middleware at all, which is
  a contract, not an omission). Imported keys and NEP-2 passphrases are read from the body
  and `Zeroizing`; a query parameter or path segment carrying either is a `400`.
- **The workbench does not relay an import.** `neo-nexus` deliberately has no
  private-key or NEP-2 request type and no browser form for either. Enclave-born
  key generation is the normal workbench path. Existing material enters through
  a signer-side import ceremony only after the importer verifies a fresh Nitro
  document, AWS chain, nonce, PCR set, runtime name, vault fingerprint,
  boundary digest and nondecreasing state revision. This stronger boundary
  prevents a browser host from retaining, logging, crash-dumping or backing up
  secret material it never accepts.
- **Every admin mutation writes an audit row.** Which key's boundary changed, from what to
  what, by which caller. A boundary nobody can account for is not a boundary. The moved
  implementation already covers each route above: `SignerAuditAction` has a variant for
  every one of them (`workers/neo-signer/src/model.rs:461-481`).
- **The boundary's advice travels with the boundary.** Both policy replies carry
  `problems: [{code, message}]` — the shapes `SignerPolicy::problems` names as legal and
  still weaker than they look: an open contract whitelist while calls are allowed, amount
  rules with transfers closed, a ceiling of zero or less. It is advice and never a refusal,
  because an operator who means "no per-transfer ceiling" must be able to save exactly that;
  the service stores it and then says what it enforces. The read carries it as well as the
  write, since a boundary saved last month is the one nobody remembers the shape of. And the
  service computes it rather than the caller, on purpose: a console that re-derived the list
  from the fields would hold a second copy of the rules, which is the failure mode §7 step 2
  exists to close. The field is additive, and a consumer that ignores unknown fields simply
  shows no warnings instead of failing to parse — so this needed no coordinated release on
  either side.

### 5.2 Enclave routes (recorded §5 change)

Three bootstrap routes live outside the `/signer/api/v1` prefix because they
must work while a vault cannot authenticate anyone yet. A fourth unprefixed
route, `/metrics`, keeps saturation observable but never changes vault state.
This is the §5 change the enclave deployment (§7 step 3) required, recorded
here as a decision rather than discovered in a compose file: before it, this
service had no unauthenticated route at all and no way to receive its master key.

| Method | Path           | Auth                      | Purpose                                                                                                   |
| ------ | -------------- | ------------------------- | --------------------------------------------------------------------------------------------------------- |
| `GET`  | `/health`      | none                      | Process liveness plus vault state: `{"status":"ok"}` when open, `{"status":"unprovisioned"}` while sealed |
| `POST` | `/provision`   | Bearer transport token    | The one door the master key comes through, walked once per boot                                           |
| `GET`  | `/attestation` | none (optional `?nonce=`) | A fresh NSM attestation document binding the vault fingerprint and the boundaries                         |
| `GET`  | `/metrics`     | none                      | Prometheus process and request metrics; no vault contents or caller labels                                |

- **The sealed window.** In an attested deployment (`SIGNER_SERVICE_ATTESTED_BOOT=require`)
  the process boots with the vault sealed: `/health` says `unprovisioned` and every custody
  and management route answers `503` with `signer-not-provisioned`. There is deliberately
  **no audit row** for a refusal in that window — the vault the audit trail lives in is not
  open yet — which is one more reason the window is kept as short as the start script can
  make it.
- **What `/provision` carries.** The body is `{"env": {…}}`, validated against a whitelist:
  the two KMS ciphertexts (`MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64`,
  `SIGNER_SERVICE_MASTER_KEY_KMS_CIPHERTEXT`), the region
  (`SIGNER_SERVICE_KMS_REGION` or the standard AWS names), and the static AWS credentials
  the host fetched from IMDSv2. Anything else is refused with `400` — a host cannot smuggle
  configuration into the enclave by adding keys. A plaintext
  `SIGNER_SERVICE_MASTER_KEY` anywhere in the body is refused with `403`
  (`signer-provision-forbidden`) before anything else is checked: that is RC2's bright line,
  with a second locked door at boot (`refuse_plaintext_master_key_at_boot`).
- **The token is checked against KMS, not against the channel.** The presented Bearer token
  is validated against a KMS-released envelope — constant-time, digest-based — so the
  credential that guards provisioning is never compared against a plaintext value that
  crossed the same channel it guards. Without the envelope release the provision fails with
  `401 signer-provision-unauthorized`.
- **Once per boot, and the race is a footrace.** Two provisions can both pass the gate and
  run; a mutex serializes them and the terminal state flip decides the winner. The loser
  has released key material into a vault nobody will serve — wasted work, not a hole. After
  the flip the route answers `409` with `signer-provision-already-done` for the life of the
  process.
- **`/attestation` is what a remote verifier pins.** The response carries a fresh-nonce COSE
  Sign1 attestation document (base64) plus the plaintext facts needed to check it: the vault
  fingerprint, each key's boundary (the same JSON whose SHA-256 is bound into the NSM
  `user_data`), the nonce echoed, and the **measured** PCR0. The nonce is caller-supplied
  (`?nonce=<hex>`, non-empty) so the verifier can confirm freshness; an unreadable nonce is
  a `400` in the refusal shape.
- **The PCR0 pin lives in the KMS key policy, not in the image.** Baking an expected-PCR0
  into the image would change the measurement it pins — circular. So the boot guard is an
  in-enclave presence proof: it answers a fresh-nonce NSM attestation and fails closed on
  the host (no NSM device), with an _optional_ `SIGNER_SERVICE_EXPECTED_PCR0` pin for tests
  and host dry-runs. The authoritative pin is the KMS key policy's
  `kms:RecipientAttestation:ImageSha384` condition, which releases the master key only to
  the enclave image whose PCR0 the operator pinned; the operator takes the measured PCR0
  the boot report and `/attestation` surface and pins it there, and in the committed
  measurements manifest (`deploy/nitro/measurements/`).

### 5.3 Official Neo SignClient gRPC bridge

The process can additionally serve the protobuf contract used by the official Neo
`SignClient` plugin: `servicepb.SecureSign/SignExtensiblePayload`, `SignBlock`, and
`GetAccountStatus`. Fields 1–8 in the checked-in proto are wire-identical to the current
official plugin. Fields 9–10 explicitly recognize the existing secure-sign state-root
extension so those bytes can never be silently discarded by protobuf decoding. This is
an adapter into the same service, not another signer: caller
grants, key state, `allow_consensus`, signature limits, audit rows, idempotency, network
binding, and the SQLite anti-equivocation journal all remain in force.

The upstream protocol carries no bearer token, client certificate, or other
authentication field. Enabling the bridge therefore requires all three settings below,
binds one endpoint to one key/caller pair, and refuses every non-loopback bind:

```text
SIGNER_SERVICE_SIGNCLIENT_PORT=9991
SIGNER_SERVICE_SIGNCLIENT_KEY_ID=key-...
SIGNER_SERVICE_SIGNCLIENT_CALLER_TOKEN=neoos_caller_...
SIGNER_SERVICE_SIGNCLIENT_HOST=127.0.0.1   # optional; loopback is mandatory
```

Neo's plugin then points `SignClient.json` at `http://127.0.0.1:9991`. The token above
never crosses gRPC; it is the bridge's internal NeoOS identity and must have `sign` plus
a grant for exactly that key. The adapter accepts both compressed and uncompressed P-256
keys, returns `Single`/`Locked`/`NoSuchAccount` using official enum values, and preserves
one response entry for every requested script hash.

`SignBlock` is a semantic path. It validates the transaction Merkle root and serializes
the exact current official header fields before signing
`networkMagicLE || SHA256(header)`. Its deterministic request id makes plugin retries
idempotent, while a dedicated `0xff` consensus reservation phase prevents the same public
key from signing a different header at the same network and height across restarts. The
current official client leaves state-root fields absent. When the known secure-sign
extension sets `state_root_enabled`, the bridge requires a 32-byte `prev_state_root` and
commits it to the signed header; it rejects a missing or unexpected root. No claim is made
for other future header extensions that are not represented in this proto.

There is no TLS or protocol-level authentication on this listener. Loopback (or a
separately reviewed loopback-to-vsock transport) is the trust boundary; it must not be
published on a LAN or internet socket.

## 6. Deployment in this repository

- Process: `workers/neo-signer` (Rust crate), beside the Node processes it is deployed
  with. `workers/` means "a process in the confidential plane", not "an npm package":
  the crate is skipped by the `workers/*` workspace glob because it carries no
  `package.json`, so `npm install` and `npm test` neither see it nor build it. Its build
  path is cargo, and its image is `deploy/nitro/Dockerfile.signer` — two stages, the second
  being the measured one: `debian:bookworm-slim` with the `signer_service`,
  `nsm-attest-rs` and `nitro_init` binaries, socat, iproute2, **and no Node and no
  other runtime, no `/bin/sh` entrypoint**. `build-custody-eif.sh` builds it and
  captures PCR0/1/2 into a `morpheus-custody` measurements manifest;
  `start-nitro-custody.sh` runs it and walks §5.2's `/provision`; `nitro_init custody`
  (`crates/nitro-init`, PID 1) brings loopback up, bridges vsock 8787 to
  127.0.0.1:8081, and fail-stops if any of the three processes dies. The retired Node
  signer image lives on as `Dockerfile.signer-legacy`, measured by
  `build-nitro-signer-eif.sh` only so the historical path keeps building while deployments
  move — the two pipelines must not be mixed, since a verifier that pins one manifest
  expects the matching enclave.
- What it is _not_ is a lane of `nitro-worker`. That worker keeps its own key handling
  until §7 step 3 retires it, and once it is a caller its `sign` lane becomes an HTTP
  client of this service. Keeping custody in a separate process is what makes the
  boundary enforceable rather than conventional: `nitro-worker`'s compute lane forks
  untrusted scripts with a stripped environment (`env: { PATH, TZ }`, `--permission`,
  `--frozen-intrinsics`), which is careful work — but a signing key in that process
  would still be a V8 heap object that nothing can zero, next to every dependency the
  lane pulls in.
- The enclave **host** is this service's first caller on the same contract as everyone
  else. `workers/nitro-enclave-host` (the split's trusted frontier) holds no keys; its
  signing plane resolves a role's pinned key by reading
  `GET /signer/api/v1/keys/{id}` and blind-signs through `POST /signer/api/v1/sign/raw`
  (§4.1) with a registered caller token — grants, the `allow_raw` boundary and the audit
  trail apply to the host's calls exactly as to any external one. What it needs is
  provisioned env, read live so `/provision` can connect or re-point custody mid-flight:
  `SIGNER_SERVICE_URL` (the custody base URL), `SIGNER_SERVICE_TOKEN` (the host's caller
  token), and `SIGNER_ROLE_{ROLE}_KEY_ID` per signing role
  (`SIGNER_ROLE_UPDATER_KEY_ID`, `SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID`). With no URL
  provisioned the plane reports the same unconfigured state the fail-closed shim did —
  `/health` shows the roles without a custody connection, and every sign route answers
  the same `503` it always did. A role whose pinned key is on the wrong network, is
  disabled, or is not granted to the host's caller reads as unconfigured with the
  reason in its issues; a raw-sign refusal carries custody's status and code through.
- Port and URL follow the existing convention (`NITRO_API_URL`, `NITRO_SIGNER_URL`,
  `SIGNER_URL`): the service is reached as `SIGNER_SERVICE_URL`, and callers resolve it
  through `config-schema.js` rather than reading `process.env` inline.
- The process takes its configuration from the environment plus one argument, and
  `workers/neo-signer/src/bin/signer_service.rs` is the only file in the tree that reads
  either; the library's single environment read is `SIGNER_SERVICE_MASTER_KEY`, resolved in
  `src/vault.rs`. That name drops the `NEONEXUS_` prefix the moved code carried: this
  service's vault is its own database, and every variable a deployment sets for it now
  shares one prefix.
  `SIGNER_SERVICE_DATA_DIR` is required and deliberately has no default: it holds
  `signer.db` and, when no master key is supplied, the generated `signer-master.key` — so a
  guessed directory would let a deployment start against an empty vault and look healthy
  doing it. `SIGNER_SERVICE_HOST` defaults to `127.0.0.1` — §5's transport assumption is
  something a deployment opts out of loudly, not something it discovers — and
  `SIGNER_SERVICE_PORT` to `8081`. `SIGNER_SERVICE_WORKLOAD_AUDIENCE` is the canonical
  public origin signed by workload v2 and defaults to that concrete bind origin;
  `SIGNER_SERVICE_ALLOW_LEGACY_WORKLOAD_V1` defaults to `false` and is a temporary
  migration switch, not a steady-state setting. `SIGNER_SERVICE_MAX_BODY_BYTES` overrides the 256 KiB
  ceiling the transport applies. `SIGNER_SERVICE_MAX_IN_FLIGHT_REQUESTS` defaults to `32`
  and bounds the whole custody route before body buffering, authentication, SQLite,
  cryptography, and blocking-pool submission; excess calls are shed immediately with the
  fixed `signer-service-busy` response. `/health` and `/metrics` stay outside that budget so
  saturation remains observable. The optional SignClient listener is configured by the
  four `SIGNER_SERVICE_SIGNCLIENT_*` variables in §5.3 and shares the same bounded blocking
  budget. Everything else about a deployment is a caller record or
  a policy row, which is to say auditable.
- Boot prints the bound address and a vault summary — fingerprint, key and caller counts,
  database path — plus one hint line when there is no `admin` caller yet or the listener is
  off loopback. Then nothing, until a signal. That is the whole observability surface, and
  it is a consequence of §5.1's ban on request logging rather than a gap in it — an operator
  confirms a restart by the fingerprint matching and by the counts not having fallen to
  zero. SIGINT and SIGTERM stop the listener and let in-flight requests finish rather than
  cutting them, because a witness half-written to a socket leaves a caller that retries
  blind.
- There is no health endpoint **on the management prefix**, so a compose healthcheck has
  nothing to hit there: §5's three routes all need a credential. The enclave routes add
  `GET /health` (§5.2) at the root — unauthenticated, because a sealed vault cannot
  authenticate anyone, and worth exactly two words (`ok` / `unprovisioned`) so it says
  nothing an attacker could use. The start script's readiness loop is its only intended
  consumer.
- One key per role, per network, recorded in `config/signer-identities.json`. That file
  stays the _public identity_ registry (address, script hash, public key) that remote
  verifiers pin — it must never gain a secret field. The service does not read
  `MORPHEUS_ALLOW_UNPINNED_SIGNERS` (§4.3), so env files feeding it either omit the
  variable or render `false`; the bootstrap files that legitimately set it to `true`
  live under `.secrets/` and are not runtime env.
- Attestation: the enclave is this service's deployment target, and the packaging of §7
  step 3's precondition has landed. The boot guard (`src/attestation.rs`) makes the
  in-enclave presence proof: with `SIGNER_SERVICE_ATTESTED_BOOT=require` the process
  answers a fresh-nonce NSM attestation before serving — which fails closed on the host,
  where no NSM device exists — and starts with the vault sealed (§5.2). The authoritative
  PCR0 pin is not in the image (baking it in would change the measurement it pins) but in
  the custody KMS key policy and the committed measurements manifest. The attested
  identity (`src/attested_identity.rs`) closes the old gap: the attestation document's
  `user_data` binds the runtime name, the **vault fingerprint** and the digest of every
  key's boundary, so a remote verifier can confirm not only _which_ keys an enclave holds
  but _what they may sign_ — the full boundary JSON rides the `/attestation` response for
  the verifier to hash-check against the bound digest.
- Vault state is ephemeral inside the enclave: the enclave's rootfs is memory-backed, so
  the database and the boot report's counts start empty on every boot. The data directory
  holds nothing plaintext — key secrets are sealed under the master key and caller tokens
  are stored as digests only — so the vault directory is portable, and restoring state
  across a boot is the follow-up §7 step 3 names for the consumers' migration, not
  something the image solves today.

## 7. Migration

Order matters: there must never be a moment when nothing owns custody.

1. **Land the service** in this repo as `workers/neo-signer`, with the earlier
   NeoNexus custody prototype (transaction parser, policy, caller auth, sealed
   vault and audit store) extracted into its proper owner and its test suite
   green.
2. **Demote `neo-nexus` to a client (implemented and contract-tested locally).**
   `neo-nexus/src/signer_client/` now owns only endpoint validation, wire
   models, bearer/workload request authentication and redirect-disabled
   `ureq` transport. Refusals remain typed data, transport failures never
   trigger a local fallback, and signing requests are not automatically
   retried. The `/signer` workbench page uses the non-secret management routes
   for enclave-born generation, policy, caller and audit operations. It has no
   private-key, passphrase, transaction-sign, consensus-sign or raw-sign form.

   Configuration is `NEONEXUS_SIGNER_URL` plus exactly one file-backed
   credential profile: `NEONEXUS_SIGNER_ADMIN_TOKEN_FILE`, or
   `NEONEXUS_SIGNER_ADMIN_CALLER_ID` +
   `NEONEXUS_SIGNER_ADMIN_WORKLOAD_KEY_FILE` and optional
   `NEONEXUS_SIGNER_ADMIN_WORKLOAD_SUBJECT`. Non-loopback endpoints require
   HTTPS; user-info, URL paths, query strings, fragments and redirects are
   refused.

   `neo-nexus/tests/unit/signer_client/client/tests.rs` contains an ignored
   real-service contract test that exercises health, generation, key reads,
   complete policy round-trip, bearer and Ed25519 workload callers, successful
   NeoX transaction/EIP-191, Neo N3 consensus and raw signatures, structured
   refusals, key disable/enable, token rotation, audit, and deletion. The default
   standalone test run ignores it because no custody process exists there.
   `scripts/run-neo-nexus-signer-contract.sh` owns a disposable vault, builds and
   starts `signer_service` on an ephemeral loopback port, provisions a protected
   admin file, runs the exact test, and cleans up on every exit. The Rust job in
   this repository and the Linux job in NeoNexus CI each check out the sibling
   main branch and invoke that harness, so either side of the contract is gated.

   A private fork that previously created `signer_*` tables in `neonexus.db`
   requires an explicit offline migration with a verified backup and matching
   master key. Mainline NeoNexus never shipped those tables, so no automatic
   database attachment or deletion is performed during workbench startup.

3. **Migrate the `/sign/payload` consumers** in this repo.

   **Precondition: the service is inside the enclave before a caller is moved to it.**
   The consumers leaving this step are inside a Nitro enclave today. The packaging has
   landed: a `Dockerfile.signer` whose _last_ stage is what nitro-cli measures — the Rust
   custody runtime, zero Node and zero shell — with `build-custody-eif.sh` pinning
   PCR0/1/2 into `deploy/nitro/measurements/` the way `build-enclave-eif.sh` already does;
   `nitro_init custody` (`crates/nitro-init`, PID 1) bridging vsock to the loopback
   listener, since vsock is the enclave's only ingress and §5's transport assumption is
   then true inside the memory boundary rather than assumed across a host network
   namespace; the master key released
   by the attested KMS path (§5.2, `deploy/nitro/TEE-CONFIDENTIALITY-GAPS.md` RC2) — never
   a host-supplied environment value crossing into an unmeasured process, and never
   `signer-master.key` in the rootfs, where the EIF would carry it in plaintext to everyone
   who can read the image; and the attestation document's user data extended to the vault
   fingerprint and each key's boundary, so a remote verifier can confirm _what the enclave
   may sign_ and not only which keys it holds. `start-nitro-custody.sh` is the walk-through
   of the whole boot; the runbook
   (`docs/runbooks/custody-enclave-deployment.md`) records the operator steps and what on
   a Nitro machine must be verified by hand.

   Then: `nitro-signer-server.mjs`
   becomes a thin compatibility shim: it keeps answering `/sign/payload` only for the one
   request kind it can translate into intent — `network magic little-endian` followed by
   the **unsigned transaction serialization**, which it forwards to the custody
   `/signer/api/v1/sign/transaction` — and refuses everything else. The legacy preimage
   the relayer used to send (`getMessageForSigning`: magic + bare txid) is a digest and
   is refused by name: a bare txid cannot be policy-checked, so the shim will not sign
   it blind. The same change removes the silent role default — a request with no
   `key_role`, or one `normalizeRole` cannot map, is refused rather than signed as
   `updater` (§4.3), in both this shim and `enclave-server.mjs`. Relayer and nitro-worker
   call sites move to `/signer/api/v1/sign/transaction` one at a time, each with its own
   caller token.

   **Relayer migration status (done for request and feed delivery):** Neo N3 request and
   feed transactions are built locally, signed through custody `/sign/transaction`,
   broadcast, HALT-confirmed and durably recorded. NeoX request delivery first obtains a
   verifier signature through the structured `/sign/eip191-fulfillment` lane, then signs
   the separate updater EIP-1559 transaction through `/sign/transaction`; NeoX feed uses
   that updater transaction lane directly. Both NeoX paths require a status-1 receipt and
   persist the confirmed outcome. The verifier and updater are distinct policy-bound keys,
   configured through `SIGNER_ROLE_NEOX_VERIFIER_KEY_ID` and
   `SIGNER_ROLE_NEOX_UPDATER_KEY_ID`; the Neo N3 updater uses
   `SIGNER_ROLE_UPDATER_KEY_ID`. The Rust relayer holds no WIF/private key and has no local
   signing fallback. Automation delivery remains explicitly fail-closed until durable
   claim, on-chain queue confirmation and run persistence are implemented.

   **Worker sign-lane migration status (done):** `workers/nitro-worker`'s sign lane —
   `/sign/payload` (`handleSignPayload`) and every signed result envelope
   (`buildSignedResultEnvelope`, which backs the compute, feed, and oracle quote lanes) —
   signs through the custody service via `src/platform/custody.js`. The worker resolves
   its key id from `SIGNER_ROLE_WORKER_KEY_ID` (default role `worker`, overridable per
   request with `dstack_key_role`/`key_role`, e.g. `oracle_verifier`), holds no derived
   Neo N3 signing key, and `NITRO_USE_DERIVED_KEYS` no longer affects Neo N3 signing.
   Requests that pass `private_key`, `signing_key`, or `wif` are rejected
   unconditionally; there is no environment escape hatch and no local signing path.
   Provisioning is enforced by `check-nitro-env.mjs`
   (`SIGNER_ROLE_WORKER_KEY_ID` is required). The feed-pusher fee
   top-up (`deploy/feed-pusher/feed-topup.mjs`) likewise builds the GAS transfer locally
   and takes its witness from custody `/sign/transaction` under
   `SIGNER_ROLE_FEE_FUNDER_KEY_ID` — no `TOPUP_WIF` on the box.

   **Worker tx-relay migration status (done):** the tx-relay lane (`chain/neo-n3.js`
   `loadNeoN3Context` / `relayNeoN3Invocation`) signs through the custody service too.
   `loadNeoN3Context` resolves a lazy signing identity from
   `GET /keys/{SIGNER_ROLE_UPDATER_KEY_ID}` — the updater account, because the lane
   relays the oracle-contract invocations the relayer fulfills under (`fulfillRequest`
   / `queueAutomationRequest`, the txproxy allowlist) — with the public key ↔ script
   hash cross-checked locally, so read-only consumers (on-chain baseline loads,
   raw-transaction broadcasts) never require custody provisioning; signing lanes force
   it with `required: true`. `relayNeoN3Invocation` builds the transaction locally,
   sizes the system fee from the simulation, sizes the network fee via
   `calculatenetworkfee` over a placeholder witness in the exact shape custody returns,
   and installs the custody witness (script-hash verified) before broadcast. The
   sponsorship lane (`sponsorNeoN3Transaction`) appends the custody witness next to
   the user's own. The worker WIF group is retired from `check-nitro-env.mjs` required
   provisioning, the request-hub compose files, and `morpheus.env.example`;
   caller-supplied key material on the relay lane is rejected under the same
   custody-only rule as the sign lane.

   **Web control-plane migration status (done):** `apps/web` no longer signs anything.
   `fulfillNeoN3RequestViaBackend` and `queueNeoN3AutomationViaBackend` used to build
   and sign these same invocations locally from the updater/relayer WIF
   (`resolveNeoN3UpdaterSigner`, since deleted); they now POST the JSON contract
   params to the worker's `/txproxy/invoke` with the runtime bearer token, and the
   worker custody-signs as the updater. The feed-tick route no longer resolves
   updater/relayer WIFs and forward them inside the `/oracle/feed` body (the worker's
   feed lane is custody-side); `feed-sync.ts` dropped its `wif`/`private_key`
   plumbing, and callback-broadcast now rejects raw signer material outright like
   automation-execute. The web tier holds no Neo N3 key and reads no WIF env var.

   **NeoDID lane + env-surface retirement (done):** NeoDID digest signatures
   (bind, action, recovery, and the runtime self-sign) sign through custody
   `/sign/raw` under the worker role — the enclave's sha256-then-ECDSA is
   byte-identical to the neon-js `wallet.sign` path it replaces — and caller key
   material is rejected like on every other lane. With that, no runtime lane in
   this repo reads signing key material from env at all, so the env surface was
   retired to match: `check-nitro-env.mjs` treats a WIF-free runtime env as the
   healthy state (a leftover WIF that disagrees with the pinned registry is
   still a hard failure), `render-nitro-compose-env.mjs` renders no WIF/private
   key into runtime env or `MORPHEUS_RUNTIME_CONFIG_JSON` (only the oracle
   verifier PUBLIC key), the request-hub compose passthroughs are gone (relayer
   services carry the custody vars), `render-nitro-hub-env.mjs` renders only the
   verifier public keys, and the root-env `n3_scripts` group moved to optional
   `smoke_signing` (smoke tooling still consumes a relayer WIF on operator
   machines by choice).

4. **Retire local key material** from the remaining paths: the WIF-bearing env vars in
   relayer and explorer. The services-repo runtime lanes and env surface are done
   (relayer, both worker lanes, web control plane, feed-topup, NeoDID, and every
   rendered env file) — what remains is smoke tooling, the pinned-registry drift
   checks, and consumers in the sibling repos.
5. **Then** evaluate `secure-sign-service-rs` as the enclave `vault` backend, which is
   the one place its KMS-attested start is worth the build complexity — noting it cannot
   compile on Windows today because `secure-sign-rpc/Cargo.toml:15` depends on
   `tokio-vsock` unconditionally (line 34 shows the feature gate that was meant to cover
   it).

Steps 1 and 2 are the boundary change. Steps 3-5 are what the boundary makes possible.

## 8. Out of scope

Multisig and threshold signatures. HSM integration. Building transactions, submitting
them to RPC, or broadcasting — the service answers "may I sign", not "here is a
transaction". On-chain balance checks; a policy ceiling is a promise about what the key
will sign, not about what the account holds. CLI and GUI front-ends for the service.
