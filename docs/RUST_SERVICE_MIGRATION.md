# Rust Service Migration

## Overview

NeoOS is migrating confidential runtime paths from JavaScript to Rust without
changing their public byte contract. The target has three explicit ownership
boundaries:

- `workers/neo-signer` is the only Neo private-key custody and signing
  authority. Its measured image is Rust-only.
- `workers/nitro-enclave-host` plus `crates/neo-os-compute` own the measured
  confidential execution frontier. `deploy/nitro/Dockerfile.enclave` contains
  only the Rust frontier and Rust PID 1 supervisor.
- `workers/nitro-worker` remains a compatibility runtime for container/CVM
  deployments and the JavaScript parity oracle while migration gates still
  consume its vectors. It is not packaged into the measured Rust EIF.

The migration is not complete merely because an image contains no Node binary.
Every route reachable in that image must execute in-process or fail closed with
an intentional, documented response. The production Rust host therefore has no
child-process supervisor or loopback Node client. Fulfillment request types not
yet folded into Rust receive the deterministic `rust-compute-lane-unavailable`
compute response; they cannot silently activate a second engine.

## API Reference

### Runtime ownership

- `neo-os-compute` exposes keyless deterministic compute, game engines,
  oracle helpers, NeoDID logic, policy, and sandbox primitives.
- `nitro-enclave-host` owns HTTP authentication, route classification,
  one-shot allowlisted provisioning, Nitro Recipient KMS materialization,
  custody calls, egress adapters, response rendering, and lifecycle.
- `neo-signer` owns P-256 key generation/import, encrypted custody, policy,
  caller authentication, idempotency, audit, and signatures.
- `nitro-worker` must not be imported by a Rust EIF build. Its public routes
  remain supported only by the separately published compatibility image until
  their deployment consumers move.

### Fulfillment dispatch

`/oracle/fulfill` dispatches migrated worker routes directly to their Rust
handlers:

- `/compute/execute`;
- `/oracle/query`, `/oracle/smart-fetch`, `/oracle/decrypt`, and
  `/oracle/message-reveal`;
- `/neodid/bind`, `/neodid/action-ticket`, and
  `/neodid/recovery-ticket`.

The remaining `/session/*`, `/vrf/random`, `/automation/execute`,
`/paymaster/authorize`, `/oracle/feed`, and `/neodid/zklogin-ticket` routes
produce `rust-compute-lane-unavailable` until their Rust host adapters land.
That failure is encoded and signed as an unsuccessful fulfillment; no network
or child process is consulted.

Every route that returns a signed result requires a healthy custody role for
the selected network. Missing, disabled, mismatched, unreachable, or incomplete
custody is `503`; Rust does not preserve the old compatibility behavior of a
successful body with null signature fields.

### Confidential material and provisioning

The measured Rust frontier does not compile or call Secrets Manager
`GetSecretValue`. The only production release primitive is
`nitro_attest::release_bytes`: a KMS CiphertextBlob is sent to KMS with a fresh
Nitro Recipient attestation and unwrapped inside the enclave.

`POST /provision` is a one-shot bootstrap route. Its documented allowlist is:

- `MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64`;
- `SIGNER_SERVICE_TOKEN_KMS_CIPHERTEXT_BASE64`;
- `MORPHEUS_ORACLE_KMS_CIPHERTEXT_BASE64`;
- `MORPHEUS_NEODID_SALT_KMS_CIPHERTEXT_BASE64`;
- `MORPHEUS_ORACLE_KMS_DIAG_CIPHERTEXT`;
- `AWS_REGION` or `NITRO_AWS_REGION`;
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`;
- provider credentials `TWELVEDATA_API_KEY` and `TD_KEY`.

Unknown names are rejected, not skipped. In particular, callers cannot set
`NODE_ENV`, `MORPHEUS_NETWORK`, URLs/endpoints, signer routing, plaintext key
material, feature gates, policy switches, or runtime trust anchors. Production
mode and network are build-time EIF inputs. Subsequent temporary AWS credential
refresh uses `POST /provision/credentials`, which accepts only the three AWS
credential fields and requires the current runtime bearer.

The X25519 KMS plaintext is a JSON envelope with purpose
`neoos/oracle-x25519/v1`, the baked network, positive version, and a
`key_material` object containing `public_key_raw` and `private_key_pkcs8`.
The NeoDID plaintext uses purpose `neoos/neodid-salt/v1`, network, positive
version, and `salt`. Both are validated before being installed in enclave
memory. Configured plaintext is refused in production unless the internal
KMS-materialization marker accompanies it. Encrypted remote references remain
an explicit 503 until an authenticated Rust claim transport exists.

The custody caller credential uses purpose
`neoos/custody-caller-token/v1`, baked network, positive version, and `token`.
Its plaintext is distinct from the runtime bearer and is never accepted
directly from `/provision`.

### Required migration gate

`npm run check:rust-migration` is the repository-level source-purity and
ownership check. It must verify:

1. the measured enclave and custody Dockerfiles install no Node runtime and
   copy no JavaScript worker;
2. the production Rust route classifier has no passthrough target or manifest;
3. the Rust host has no production child-process or loopback-worker bridge;
4. custody clients contain no Neo private-key, WIF, NEP-2, or local signing
   fallback;
5. measured Rust source contains no Secrets Manager `GetSecretValue` builder,
   secret-id configuration, wall-clock/xorshift security RNG, or null signed
   success envelope;
6. JavaScript compatibility engines remain covered by byte/behavior parity
   vectors until their last deployment consumer is removed.

The gate is a structural check, not proof of semantic parity. Cargo and Node
test suites provide that proof.

## Usage Examples

Run the migration checks and both sides of the parity boundary:

```bash
npm run check:rust-migration
node scripts/export-rust-vectors.mjs --check
cargo test --workspace --all-targets --locked
npm --prefix workers/nitro-worker test
```

Build a network-bound EIF and provision only ciphertext:

```bash
MORPHEUS_NETWORK=mainnet \
SIGNER_SERVICE_URL=https://custody.internal.example \
SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID=<raw-verifier-key-id> \
SIGNER_ROLE_UPDATER_KEY_ID=<raw-updater-key-id> \
SIGNER_ROLE_RELAYER_KEY_ID=<raw-relayer-key-id> \
SIGNER_ROLE_WORKER_KEY_ID=<raw-worker-key-id> \
  ./deploy/nitro/build-enclave-eif.sh
./deploy/nitro/provision-enclave-compute.sh
```

The build script passes the network as a Docker build argument. Reusing one EIF
across networks is not supported because network is part of the measured trust
boundary.

Before deleting a JavaScript engine or crypto adapter, locate all production
imports and deployment references:

```bash
rg "module-or-route-name" workers deploy scripts .github
```

No compatibility source is deleted while a published image, compose topology,
runbook, or rollback command still names it.

## Design Decisions

### Rust is the measured-runtime authority

Parity starts with JavaScript as the behavioral oracle, but once a route is
switched in the measured image, Rust is its production authority. Rollback is
an older measured image, not a dormant second engine inside the same image.
Keeping two executable engines in one trust boundary doubles review surface
and lets configuration silently choose the weaker one.

### Compatibility is explicit

The Node worker remains because standalone CVM/container deployments still
publish and reference it. Its existence does not authorize the Rust host to
fall back to it. Each compatibility runtime has a separate image, route
surface, and retirement condition.

The first engine-retirement increment removes `BridgeChild` and
`LoopbackBridge` from `nitro-enclave-host`. The `BridgePlane` trait remains
only as a deterministic unit-test seam around fulfillment encoding. Production
dispatch has no bridge object; the explicit refusal is a pure response
constructor and performs no IO.

### Crypto follows ownership boundaries

Shared encoding and envelope primitives belong in audited Rust crates.
Custody-only operations stay in `neo-signer`. Consumers may hold workload
authentication keys but may not depend on Neo custody/signing libraries or
load a Neo private key. Handwritten cryptographic primitives are removed only
after fixed external vectors prove byte equivalence with the replacement.

Randomness used by privacy noise and future VRF adapters comes from `OsRng` in
production. Compute functions retain an injected uniform-draw closure so tests
can assert deterministic vectors without replacing the production entropy
source.

### Engine copies retire by consumer, not filename

Generated MiniApp engine bundles, the Node worker ports, and Rust engines may
coexist only while they serve distinct compatibility or parity roles. A copy
is removable when production imports are zero, its deployment image is
retired, and parity vectors have moved to an implementation-independent
fixture. A comment calling a file “legacy” is not a retirement gate.

## Test Coverage

The minimum acceptance suite is:

- `cargo fmt --all --check`;
- `cargo clippy --workspace --all-targets --locked -- -D warnings`;
- `cargo test --workspace --all-targets --locked`;
- signer/NeoNexus real-process contract tests;
- JavaScript worker and relayer suites while compatibility images remain;
- generated-vector drift checks;
- the Rust migration structural gate;
- KMS X25519/NeoDID context validation, one-shot/allowlist provisioning, and
  separately authorized credential-rotation tests;
- 503 fail-closed tests for missing, disabled, wrong-network, unreachable, and
  incomplete custody responses;
- deterministic noise tests over an injected RNG and a source-purity check
  excluding wall-clock/xorshift production entropy;
- Docker build inspection proving each measured runtime contains only its
  documented binaries and no alternate signing or execution engine.

Documentation coverage for a migrated lane is complete only when its public
route, Rust owner, compatibility status, parity evidence, deployment image,
and rollback procedure are all named here or in a linked runbook.

### Documentation coverage gate

`npm run check:rust-migration` reports a machine-checked coverage percentage
for security-critical Rust ownership pairs. The required threshold is **100%**:
the implementation and its paired document must both exist, and the document
must contain `Overview`, `API Reference`, `Usage Examples`, `Design Decisions`,
and `Test Coverage` sections.

The initial measured set is:

- `workers/neo-signer/src/lib.rs` → `docs/SIGNER_SERVICE_V2.md`;
- `workers/nitro-enclave-host/src/lib.rs` → this document;
- `crates/neo-os-compute/src/lib.rs` → this document;
- `crates/neo-os-compute/src/oracle/crypto.rs` →
  `docs/CRYPTO_OWNERSHIP.md`.

Adding a security-critical Rust owner without adding its pair to the gate is a
review failure. A reported `4/4 (100%)` is the current acceptance baseline; the
numerator and denominator must grow together as migration expands.
