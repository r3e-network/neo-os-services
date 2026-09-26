# Rust Service Contract Matrix

This matrix is the operational source of truth for the backend migration. A
Rust crate existing in the workspace does not by itself make that crate the
production authority; authority changes only after its semantic and deployment
gates pass.

## Process ownership

| Process              | Owns                                                                                                                            | Must not own                                                                                          | Lifecycle                                                       | Current authority                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------- |
| `neo-signer`         | Chain-bound key generation/import, encrypted custody, policy, caller authentication, idempotency, audit, N3 and NeoX signatures | Chain scanning, compute, orchestration, caller private-key fallbacks                                  | `neo-os-service-runtime` shutdown/drain; measured Rust-only EIF | Rust authority                      |
| `nitro-enclave-host` | Authenticated confidential routes, Nitro/KMS provisioning, in-process compute, custody client, attestation, response envelopes  | Private keys, Node child execution, silent compatibility fallback                                     | `neo-os-service-runtime` shutdown/drain; measured Rust-only EIF | Rust authority for the routes below |
| `neo-os-relayer`     | N3/NeoX request/feed discovery, custody delivery, confirmation, durable state, orchestration, metrics                           | Private keys, unsigned-success shortcuts, cursor advancement without an authoritative delivery result | Structured tracing and shared shutdown                          | Rust production authority           |
| `nitro-worker`       | Frozen compatibility and parity evidence only                                                                                   | Measured-image or production execution authority                                                      | Node compatibility image                                        | Non-authoritative compatibility     |
| `morpheus-relayer`   | Frozen compatibility and parity evidence only                                                                                   | New consensus, custody logic, or production delivery authority                                        | Node compatibility service                                      | Non-authoritative compatibility     |

`workers/morpheus-relater-rs` is not a process in this matrix. It is a
retired heartbeat skeleton (`morpheus-relayer-rs` package), excluded from
the Cargo workspace and from measured Docker contexts. Do not treat it as
`neo-os-relayer`, as Node `morpheus-relayer`, or as a production authority.

Signer is therefore part of one service architecture, but not one process.
Keeping the custody process and measurement separate is the security boundary:
the relayer, host, and NeoNexus receive public identity and signatures, never
key material.

## Host route authority

| Route/lane                                                                                                | Rust owner                                              | State                                                                                               |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `/health`, `/attestation`, `/provision`, `/provision/credentials`                                         | `nitro-enclave-host`                                    | Authoritative                                                                                       |
| `/sign/payload`, `/keys/derived`                                                                          | Host + custody client                                   | Authoritative                                                                                       |
| `/feed/sign`                                                                                              | Host + custody client                                   | Neo N3 and NeoX authoritative                                                                       |
| `/oracle/fulfill`                                                                                         | Host + compute + custody client                         | Neo N3 and NeoX authoritative request computation/signing                                           |
| `/compute/execute`                                                                                        | `neo-os-compute` through host                           | Authoritative                                                                                       |
| `/oracle/query`, `/oracle/smart-fetch`, `/oracle/decrypt`, `/oracle/message-reveal`, `/oracle/public-key` | `neo-os-compute` through host                           | Authoritative                                                                                       |
| `/neodid/bind`, `/neodid/action-ticket`, `/neodid/recovery-ticket`, `/neodid/zklogin-ticket`              | `neo-os-compute` through host                           | Authoritative                                                                                       |
| `/vrf/random`                                                                                             | KMS-root HMAC subkey + custody-signed D5 envelope       | Authoritative                                                                                       |
| `/paymaster/authorize`                                                                                    | Rust policy/RPC evaluation + custody-signed D5 envelope | Authoritative                                                                                       |
| `/session/start`, `/session/step`, `/session/finalize`                                                    | `neo-os-games` through host                             | Authoritative in-process adapter; session state is host-process scoped                              |
| `/automation/execute`                                                                                     | `neo-os-compute` through host                           | Authoritative adapter for an already-claimed upkeep; the durable relayer scheduler remains disabled |
| `/oracle/feed`                                                                                            | `neo-os-compute` through host                           | Observation, aggregation, and policy adapter only; it does not submit an on-chain transaction       |

Transient compute failures (`408`, `425`, `429`, and `5xx`) must leave the
fulfillment retryable and must never be signed as a permanent on-chain result.
Business-level deterministic refusals may be encoded and signed.

## Cross-service wire contract

- Every semantic sign request may carry `request_id`, `chain_family`, and the
  chain identifier. Neo N3 binds P-256 to network magic; NeoX binds secp256k1
  to EIP-155 chain ID.
- Key chain family and chain identifier are immutable custody metadata. A key
  cannot be reinterpreted on another curve or chain.
- NeoX transaction signing returns `signed_transaction`, the complete typed
  transaction ready for broadcast. Compatibility aliases must not obscure that
  it is not a 65-byte signature.
- Idempotent replay returns the same complete result, including the signed NeoX
  transaction and chain identity.
- Policy read/edit/write paths preserve every EVM policy field; an older client
  must not erase fields it does not understand.
- Custody clients send bearer authentication and a request-level timeout. A
  transport that cannot do so fails closed.
- Management credentials are scrubbed from every supervised child process.
  Remote cleartext HTTP custody URLs are rejected; loopback HTTP remains
  available for a local proxy boundary.

## Cutover gates

The JavaScript relayer and compatibility worker are not deleted until all of
the following evidence exists:

1. Rust fulfillment performs compute, custody signing, broadcast, and chain
   confirmation as one closed state machine.
2. A failed or incomplete delivery cannot advance the authoritative cursor or
   consume its last retry as success.
3. Feed lanes have execution-confirmation semantics, not queue acceptance
   semantics; automation stays disabled until it independently meets the same
   rule.
4. Testnet shadow output is byte-equivalent for the frozen parity corpus, then
   canary delivery remains clean through the documented observation window.
5. Rust images, systemd/compose assets, health checks, rollback instructions,
   and PCR/KMS measurement pins are updated together.
6. `npm run format:rust:check`, workspace clippy with `-D warnings`, workspace tests, migration
   structural checks, JavaScript compatibility suites, and NeoNexus signer
   contract tests all pass.

The request/feed gates above now back the Rust production cutover. Frozen Node
artifacts remain parity/rollback evidence, not a runtime fallback. Automation
is still outside the cutover and remains fail-closed until its durable
claim/confirmation/persistence gate passes independently.
