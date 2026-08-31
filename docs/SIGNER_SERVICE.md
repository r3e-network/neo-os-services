# Signer Service

Status: **the contract and the ownership boundary are defined here; the implementation
is mid-migration.** Section [7](#7-migration) says exactly what exists today and what
has to move.

## 1. Purpose

The signer service is the only component in NeoOS allowed to hold an unlocked Neo N3
private key, and the only component that decides whether a given key signs a given
intent. Everything else — the web host, the admin console, the explorer, the relayers,
node-operations tooling — asks it to sign and is told yes or no.

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
relayer call sites still use the endpoint (`workers/morpheus-relayer/src/fulfillment/signer.js:186-194`,
`workers/morpheus-relayer/src/neo-n3.js:883-895`).

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

The `neo-nexus` row is a change of status: that repository currently contains a complete
signing engine (policy, caller auth, sealed vault, audit) built before this boundary was
drawn. It is the right _code_; it is in the wrong _owner_. Section 7 moves it.

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

### 4.2 A key carries its own boundary and its own chain

Each custody key stores its policy — allowed operations, contract allow/deny lists,
asset allow/deny lists, recipient allow/deny lists, single-amount ceiling, rolling
window ceiling and window length — and its network magic.

- **The default is closed.** A key with no saved boundary signs nothing. An empty form
  save must mean "everything refused", never "no restrictions".
- **The magic is stored per key, not derived from a chain name.** A name-derived magic
  cannot distinguish two private networks that share a default, and one signature is
  then valid on both.

### 4.3 A caller is a registered identity, not a shared secret

Each caller has its own token; each token is granted a specific set of keys. Browser
callers declare an `Origin` (or `Referer` for navigations) that is checked against the
origins recorded for them; server-to-server callers record none and are refused if they
present one. Refusals are attributable: caller, key, reason code and the digest of what
was refused all reach the audit trail.

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

| Method | Path                              | Purpose                                                                                         |
| ------ | --------------------------------- | ----------------------------------------------------------------------------------------------- |
| `POST` | `/signer/api/v1/sign/transaction` | Sign SerializeUnsigned transaction bytes                                                        |
| `POST` | `/signer/api/v1/sign/consensus`   | Sign consensus payload bytes                                                                    |
| `GET`  | `/signer/api/v1/keys/{id}`        | Public identity of a key: address, script hash, verification script, whether signing is enabled |

Both sign requests take `{"key_id": string, "unsigned_hex": string}`.

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

The caller assembles the witness itself; the service neither builds nor broadcasts
transactions.

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
`signer-request-too-large`, `500` otherwise — which in practice means
`signer-service-failed`.

Two codes are matched before their audit outcome is consulted, and the disagreement is
deliberate rather than an oversight in the table above. `signer-transaction-unparsable`
records `Failed` but answers `400`: the request was undeliverable, and the caller's next
move is to fix the bytes, not to wait for us. `signer-key-unknown` records `Failed` but
answers `404`: what a caller needs to branch on is that the id is not here, and the
signing path and the management path agree on that code precisely so neither can be used
to classify the other's ids.

### Reason codes

Transport layer, four codes for requests that never reached a decision:
`signer-request-unreadable` (a body that is not JSON, or a field whose value is not what
§5 says it is — the message names the caller's own field, which is the useful half, and
never quotes the input, because on `/keys/import` the input is a private key),
`signer-request-too-large`, `signer-route-unknown` (an unmatched path answers in the
refusal shape, so nothing this service sends makes a client guess whether it is talking
JSON), and `signer-service-failed` (the store refused a read, a write or the clock; the
message is fixed and the specifics go to an audit row the transport writes itself, since
the service that would have recorded them never got that far).

The first three are answered without authenticating the caller and write no audit row.
That is safe because each describes only the caller's own bytes or its own URL — there is
no vault fact to leak and nothing attributable to record — and it is why a malformed body
cannot be the one thing on this service that answers in `text/plain`.

Access layer: `missing-token`, `unknown-token`, `caller-disabled`, `origin-required`,
`origin-not-allowed`, `origin-unexpected`, `key-not-granted`, and `admin-capability-missing`
— the last one covering both directions of a capability mismatch (§5.1), so no route can
be used to classify a bearer string that was not issued for it.

`signer-admin-request-invalid` is the one code on the management surface whose `message` is
specific rather than generic, and the exception is deliberate: `guard_admin` runs before the
request body is read, so nothing reaches that constructor without already holding `admin` and
a whole-vault grant. Whoever is on the receiving end of it is the operator who can act on it.
It is still never the caller's own input echoed back — a rejected private key string is a
secret, and it appears in neither the message nor the stored detail.

Key guards: `signer-key-disabled`, `signer-custody-mismatch`,
`signer-public-key-unusable`.

Policy layer, 18 codes: `consensus-forbidden`, `consensus-category-forbidden`,
`consensus-sender-mismatch`, `transfer-forbidden`, `contract-call-forbidden`,
`not-a-signer`, `global-scope-forbidden`, `delegation-missing`, `contract-blacklisted`,
`contract-not-whitelisted`, `asset-blacklisted`, `asset-not-whitelisted`,
`recipient-blacklisted`, `recipient-not-whitelisted`, `source-mismatch`,
`negative-amount`, `single-amount-exceeded`, `window-amount-exceeded`.

Codes are stable wire vocabulary. Renaming one is a breaking change; adding one is not.

### 5.1 Management API (v1)

Migration step 2 is impossible without this surface. Key generation, import, boundary
editing and caller provisioning exist today only as form posts behind `neo-nexus`'s own
session cookie (`src/web/signer_control.rs`), so a consumer that cannot hold a key also
cannot currently configure one. Each route below maps 1:1 onto a method that already
exists on `SignerService`; nothing here is new behaviour, only a transport for it.

| Method   | Path                                 | Service method                                           |
| -------- | ------------------------------------ | -------------------------------------------------------- |
| `POST`   | `/signer/api/v1/keys`                | `generate_key(label, network)`                           |
| `POST`   | `/signer/api/v1/keys/import`         | `import_key(label, network, private_key)`                |
| `POST`   | `/signer/api/v1/keys/import-nep2`    | `import_nep2_key(label, network, nep2, passphrase)`      |
| `GET`    | `/signer/api/v1/keys`                | `list_keys` — every key's `KeyPublicInfo`                |
| `POST`   | `/signer/api/v1/keys/{id}/state`     | `set_key_disabled` — the one-click disable               |
| `POST`   | `/signer/api/v1/keys/{id}/policy`    | `save_policy` (blank means everything closed, §4.2)      |
| `GET`    | `/signer/api/v1/keys/{id}/policy`    | `key_detail` — the boundary as it was stored, normalized |
| `DELETE` | `/signer/api/v1/keys/{id}`           | `delete_key`                                             |
| `POST`   | `/signer/api/v1/callers`             | `create_caller(label, grant, capabilities, origins)`     |
| `GET`    | `/signer/api/v1/callers`             | `list_callers` — `CallerInfo`, digest excluded           |
| `POST`   | `/signer/api/v1/callers/{id}/rotate` | `rotate_caller_token`                                    |
| `POST`   | `/signer/api/v1/callers/{id}/state`  | `set_caller_disabled`                                    |
| `DELETE` | `/signer/api/v1/callers/{id}`        | `delete_caller`                                          |
| `GET`    | `/signer/api/v1/audit`               | `list_audit` — newest first, optionally filtered by key  |

`GET /keys/{id}/policy` is a different path from `GET /keys/{id}` (§5) because the two are
guarded differently and return different things: the identity read is answered for a caller
holding `sign` and a granted key, the boundary read needs `admin`. Reusing one path for two
guards is how a route ends up answering whichever check happens to be reached first.

The rules that hold it together:

- **One caller table with capabilities, not a second auth system.** A caller record carries
  a capability set naming **exactly one** of `sign` or `admin`. `POST /callers` refuses an
  empty set, a set naming both, and an unknown name — all before a token is minted, so a
  rejected request cannot leak a credential into existence. Two parallel credential stores is
  how one of them stops being checked — which is the shape of F-9's problem, restated before
  it can recur here.
- **Admin credentials cannot sign; signing credentials cannot administer.** Either
  mismatch refuses with `admin-capability-missing` — including an admin token used on a
  sign route, which must not be disguised as `signer-key-unknown`. A missing capability
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
- **A consumer may relay an import; it may not hold one.** `neo-nexus`'s console keeps its
  "paste a key" form, because an operator who put custody in an enclave still has to get a
  key _into_ it somehow, and making that a shell ceremony is how keys end up in shell
  history. What the previous bullet forbids on this side of the wire is the resting state,
  not the transit: the bytes appear in one request body and reach nothing else — no seal, no
  derivation, no row, no log, no copy that outlives the call. `neo-nexus/src/signer_client`
  holds no crypto dependency at all, which is the checkable form of the rule: an import that
  tried to keep a key would have to add the dependency first. A relayed import is attributed
  to the relaying console caller by its own `signer-key-imported` audit row, so the workbench
  being the messenger never makes the act anonymous.
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

Three routes live outside the `/signer/api/v1` prefix, because they exist to
bootstrap a vault that cannot authenticate anyone yet. This is the §5 change the
enclave deployment (§7 step 3) required, recorded here as a decision rather than
discovered in a compose file: before it, this service had no unauthenticated route
at all and no way to receive its master key.

| Method | Path           | Auth                      | Purpose                                                                                                   |
| ------ | -------------- | ------------------------- | --------------------------------------------------------------------------------------------------------- |
| `GET`  | `/health`      | none                      | Process liveness plus vault state: `{"status":"ok"}` when open, `{"status":"unprovisioned"}` while sealed |
| `POST` | `/provision`   | Bearer transport token    | The one door the master key comes through, walked once per boot                                           |
| `GET`  | `/attestation` | none (optional `?nonce=`) | A fresh NSM attestation document binding the vault fingerprint and the boundaries                         |

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

## 6. Deployment in this repository

- Process: `workers/neo-signer` (Rust crate), beside the Node processes it is deployed
  with. `workers/` means "a process in the confidential plane", not "an npm package":
  the crate is skipped by the `workers/*` workspace glob because it carries no
  `package.json`, so `npm install` and `npm test` neither see it nor build it. Its build
  path is cargo, and its image is `deploy/nitro/Dockerfile.signer` — two stages, the second
  being the measured one: `debian:bookworm-slim` with the `signer_service` and
  `nsm-attest-rs` binaries, socat, iproute2 and the custody entrypoint, **and no Node and
  no other runtime**. `build-custody-eif.sh` builds it and captures PCR0/1/2 into a
  `morpheus-custody` measurements manifest; `start-nitro-custody.sh` runs it and walks
  §5.2's `/provision`; `entrypoint-custody.sh` brings loopback up, bridges vsock 8787 to
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
  `SIGNER_SERVICE_PORT` to `8081`. `SIGNER_SERVICE_MAX_BODY_BYTES` overrides the 256 KiB
  ceiling the transport applies. Everything else about a deployment is a caller record or a
  policy row, which is to say auditable.
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

1. **Land the service** in this repo as `workers/neo-signer`, with the engine moved
   from `neo-nexus/src/signer/` (transaction parser, policy, caller auth, sealed vault,
   audit store) and its test suite, gates green.
2. **Demote `neo-nexus`** to a client of it: the operator console and control pages keep
   their shape, but talk HTTP to the service. `neo-nexus` must end up unable to open,
   derive, export or accept a private key — its wallet module already refuses plaintext
   keys, and the signer client inherits that property. The client is
   `neo-nexus/src/signer_client`: seventeen routes over blocking `ureq`, a refusal returned
   as data rather than as a failed request, and no crypto dependency to violate the rule
   with. `a_real_service_and_this_client_agree_on_every_route` is the `#[ignore]`d probe
   that exercises every route against a running service, which is the only way to show the
   two halves agree rather than that each reads its own tests.

   **Existing rows migrate by the operator's hand, and nothing here deletes them.** A
   `neonexus.db` predating this step already holds `signer_keys`, `signer_policies`,
   `signer_callers`, `signer_audit` and `signer_value_events` — the same five tables and the
   same columns, apart from `capabilities`, which the service adds to an old-shaped table on
   open (`workers/neo-signer/src/store/schema.rs:98-106`). So the move is an `ATTACH` of the
   old file into `signer.db` and one `INSERT … SELECT` per table, run against a directory
   that has served nothing yet — `signer_audit.id` and `signer_value_events.id` are one
   `AUTOINCREMENT` sequence in each file, so copying into a database the new service has
   already written to can collide on a primary key, which fails the statement rather than
   quietly renumbering history. Point `SIGNER_SERVICE_DATA_DIR`
   at the directory holding the old `signer-master.key` — or
   `SIGNER_SERVICE_MASTER_KEY` set to the same credential, since only the variable's name
   changed (§6) and the derivation did not.

   The fingerprint is the check, and it is worth running rather than assuming: the service
   prints `SHA-256(master key)` truncated to four bytes at boot, and `neo-nexus` computed
   that same value for that same key, so matching strings are proof the seals will open.
   Matching is not the likely failure — a silent one is, because a key row stores its
   `public_key` in plaintext: a vault opened under the wrong master credential still lists
   every key and still answers `GET /keys/{id}` with an address, and presents as a healthy
   vault until the first signature is refused.

   Migrated caller rows arrive as `capabilities = 'sign'`, which is the point of that
   default: a token minted before the management API existed was never an admin token. The
   console credential is therefore created by `provision-admin` against the new directory,
   and the copied ones are re-granted or deleted by the operator, not promoted. `neo-nexus`
   then stops creating the five tables and does **not** drop them — dropping a vault's
   history is an operator decision, and a workbench upgrade must not be the moment it
   disappears.

3. **Migrate the `/sign/payload` consumers** in this repo.

   **Precondition: the service is inside the enclave before a caller is moved to it.**
   The consumers leaving this step are inside a Nitro enclave today. The packaging has
   landed: a `Dockerfile.signer` whose _last_ stage is what nitro-cli measures — the Rust
   custody runtime, zero Node — with `build-custody-eif.sh` pinning PCR0/1/2 into
   `deploy/nitro/measurements/` the way `build-enclave-eif.sh` already does;
   `entrypoint-custody.sh` bridging vsock to the loopback listener, since vsock is the
   enclave's only ingress and §5's transport assumption is then true inside the memory
   boundary rather than assumed across a host network namespace; the master key released
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
   becomes a thin compatibility shim: it keeps answering `/sign/payload` only for a
   fixed allowlist of request kinds it can translate into intent, and refuses
   arbitrary `data_hex`. The same change removes the silent role default — a request
   with no `key_role`, or one `normalizeRole` cannot map, is refused rather than signed
   as `updater` (§4.3). Relayer and nitro-worker call sites move to
   `/signer/api/v1/sign/transaction` one at a time, each with its own caller token.

4. **Retire local key material** from the remaining paths: `workers/nitro-worker`
   (which also compares `scopes === WitnessScope.Global`, so `0x81` passes — it must
   test the bit), and the WIF-bearing env vars in relayer and explorer.
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
