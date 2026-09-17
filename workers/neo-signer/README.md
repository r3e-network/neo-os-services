# neo-signer

The Neo N3 and NeoX signer service: chain-bound key custody, per-key signing
policy, caller authentication and the audit trail.

Per `docs/SIGNER_SERVICE.md` (section 3), this repository owns the signer, and
`neo-nexus` is a consumer of it. This crate is that owner: the engine moved out
of `neo-nexus/src/signer/` plus its own SQLite store. It sits in `workers/`
beside the Node processes it is deployed with, and it is a plain cargo package on
purpose — **not** an npm workspace member. A `package.json` here would put it
back in the glob, and every aggregate `npm -ws` script would then treat a Rust
crate as a Node package. Nothing else keeps it out: `workers/*` matches this
directory, and npm skips it only because there is no manifest to read.

## What is here

| Module       | Role                                                                                  |
| ------------ | ------------------------------------------------------------------------------------- |
| `crypto`     | P-256/K-256 signing, Neo/EVM identities, AES-256-GCM sealing, NEP-2 import            |
| `coordinator`| TestNet v2 SigV4/rustls authority client, RSA session transport, restore orchestration |
| `durable`    | Commit-before-release state machine and independent KMS receipt verification          |
| `snapshot`   | Whole-vault authenticated encrypted snapshots bound to generation/fence/predecessor   |
| `tx`         | Decodes N3 transactions, NeoX EIP-1559 transactions and consensus policy intents      |
| `policy`     | The pure decision function: does this boundary let this key sign this request         |
| `auth`       | Caller tokens, origin binding, constant-time digest comparison                        |
| `audit`      | Refusal vocabulary: what a caller may see vs. what the log keeps                      |
| `vault`      | Where the master key comes from (env credential or data-dir file)                     |
| `store`      | The eight `signer_*` tables, their indexes, and the row mappers                       |
| `model`      | The stored types: keys, boundaries, callers, audit rows, and the `ScriptHash`         |
| `service`    | `SignerService`: the signing path, the management surface, and the rows both write    |
| `network`    | Chain identity: Neo N3 network magic and NeoX EIP-155 chain-id tables                 |
| `api`        | The axum router: §5's caller routes, §5.1's management routes, and the refusal shapes |
| `neo_block`  | Validated Neo header encoding and transaction Merkle-root verification                |
| `signclient` | Official Neo SignClient gRPC adapter with one durability barrier per RPC              |
| `vault_profile` | Immutable vault, network, KMS, coordinator, and receipt-key bindings               |

`src/bin/signer_service.rs` is the process. Its configuration is environment-only
(`SIGNER_SERVICE_DATA_DIR` is required; host, port, the body ceiling, and the bounded
in-flight custody budget have defaults), and it has one argument besides `serve`:
`provision-admin <label>`, which mints the first admin credential against a data directory.
That mode writes the token to stdout and everything else to stderr, precisely so it can be
piped into a secret manager — §5.1 keeps it off the HTTP surface, where it would be a route
that mints admins forever. The default request budget is 32 and can be changed with
`SIGNER_SERVICE_MAX_IN_FLIGHT_REQUESTS`; excess custody calls receive a refusal-shaped
`503` with `Retry-After`, while health and metrics remain available.

Ed25519 workload callers use `neoos-workload-v2`, which commits to one canonical,
path-free signer origin. `SIGNER_SERVICE_WORKLOAD_AUDIENCE` sets that origin (the
concrete bind origin is the loopback default); deployments behind TLS or an unspecified
bind must set the public origin explicitly. Audience-less v1 is rejected unless the
temporary `SIGNER_SERVICE_ALLOW_LEGACY_WORKLOAD_V1=true` migration switch is set.

For an official Neo node, set `SIGNER_SERVICE_SIGNCLIENT_PORT`,
`SIGNER_SERVICE_SIGNCLIENT_KEY_ID`, and `SIGNER_SERVICE_SIGNCLIENT_CALLER_TOKEN`, then
point the node's `SignClient.json` endpoint at that loopback port. The protocol itself has
no authentication, so this listener refuses non-loopback addresses. It is one configured
key/caller bridge and supports all three official RPCs; block signing uses the semantic
Merkle-validated, durable anti-equivocation lane and never `/sign/raw`.

In attested mode the process does not call `Store::open` at boot. `/provision`
releases the master key, creates an attested RSA-3072 transport key, obtains a
sealed v2 coordinator session, reads the strongly consistent HEAD, and performs
takeover. Genesis is accepted only when HEAD is absent and the local database
path is empty. A non-genesis boot downloads the exact S3 key/version from HEAD,
checks its byte size and SHA-256, authenticates its vault/profile/network,
generation, snapshot fence and predecessor, and installs it without overwriting
local state. `DurableState` is attached before the router publishes `Ready`.

The coordinator session path is intentionally fail closed. The signer does not
decode or pretend to verify Nitro evidence itself: it supplies a real NSM
document bound to the challenge and RSA key, and accepts a session only after
the authority returns a token encrypted with RSA-OAEP-SHA256 to that exact key.
At present the authority's production attestation verifier refuses session
issuance by default. Consequently an attested durable boot cannot become Ready
until `deploy/custody-state-authority/src/attestation.mjs` implements the full
AWS Nitro COSE/certificate/timestamp/PCR/nonce/user-data/SPKI verification gate
documented by that service. There is no bypass in this client.

Every observable mutation snapshots SQLite, obtains an immutable versioned S3
object, and submits the exact same v2 commit body and permanently bound
`commit_id` on ambiguous retry. Receipt verification independently binds the
vault/profile/network/root, owner, epoch, new snapshot fence, predecessor
snapshot fence/hash, generation, mutation, object key/version/size/hash, and
lease. Health renews and verifies that exact lease remotely; local readiness
alone is not healthy.

The first consumer migration is implemented in the sibling `neo-nexus`
repository: it now contains a client and operator surface only, with a
real-process contract test against this binary. The in-repository
`/sign/payload` consumers have likewise moved to these routes; the remaining
work is retirement of compatibility engines only after the relayer delivery,
session, feed, and production attestation gates pass. Per-asset value limits,
signature-rate limits and NeoX chain-bound policy are already enforced inside
this service.

`scripts/run-neo-nexus-signer-contract.sh` is the lifecycle owner for that
cross-repository test. It builds this binary, provisions a disposable admin,
binds an ephemeral loopback port, runs NeoNexus's ignored contract module, and
cleans the process, credential, and vault on every exit. Both repositories'
Linux CI invoke it against the sibling main branch.

NeoX oracle verification has its own semantic endpoint,
`POST /signer/api/v1/sign/eip191-fulfillment`. It accepts structured fulfillment fields,
rebuilds the chain/contract-bound digest and EIP-191 prehash internally, and returns a
recoverable signature only when the key's exact NeoX chain, oracle-contract whitelist,
and `fulfillRequest` selector whitelist all match. It never accepts a caller-supplied
digest and is independent from the raw-signing capability.

## Build and test

From this directory, not from the repository root:

```sh
cargo build
cargo test
cargo clippy --all-targets -- -D warnings
# From the repository root:
npm run format:rust:check
```

The first build compiles `rusqlite` with the `bundled` feature, so it needs a C
compiler and takes a few minutes.

`Cargo.lock` is committed: a custody service has to be rebuildable byte for
byte. `target/` is not (`.gitignore`).

The tests live under `tests/unit/` but are not integration tests: each module in
`src/` pulls its own file in with `#[cfg(test)] #[path = "../tests/unit/x.rs"]
mod tests;`, so every test runs inside the library and can reach the module's
private items — which is how the store tests open a raw connection, how the
service tests reach `SignerService`'s guards, and how the api tests exercise the
router with `oneshot` instead of binding a port. There is no `tests/*.rs` target
and adding one would compile the same files twice.

The coordinator protocol test consumes
`deploy/custody-state-authority/test/fixtures/protocol-v2.json` directly and
pins both JS canonical byte strings and their SHA-256 digests. The vector is
owned by the authority and is never copied into this crate.

## Reference

- `../../docs/SIGNER_SERVICE.md` — ownership matrix (§3), the HTTP contract `api`
  implements (§5), the management API it serves only to an `admin` caller (§5.1), and
  the migration order (§7).
