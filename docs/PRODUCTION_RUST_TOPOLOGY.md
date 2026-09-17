# Production Rust service topology

This document is the deployment authority map for the Rust migration. It is
deliberately stricter than the parity inventory: keeping a Node implementation
for comparison does not make it a production authority.

## Authority matrix

| Plane                       | Runtime artifact                                                                 | Deployment status                     | Fail-closed boundary                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------- | -------------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nitro frontier / host       | `enclave_host` from `deploy/nitro/Dockerfile.enclave`                            | Rust authoritative measured EIF       | Unimplemented request types return an explicit refusal; there is no Node fallback. NeoX `/feed/sign` uses the measured `SIGNER_ROLE_NEOX_UPDATER_KEY_ID` for EIP-1559 submission, while NeoX fulfillment proofs use the separate measured `SIGNER_ROLE_NEOX_VERIFIER_KEY_ID` for semantic EIP-191 signing.                                                                                                |
| Custody signer              | `signer_service` from `deploy/nitro/Dockerfile.signer`                           | Rust authoritative measured EIF       | Boots sealed, accepts only the attested provisioning whitelist, and returns 503 until provisioning succeeds.                                                                                                                                                                                                                                                                                              |
| Relayer                     | `neo-os-relayer` from `deploy/nitro/Dockerfile.relayer`                          | Rust authoritative production service | Neo N3 and NeoX request/feed lanes require custody signing, successful HALT/receipt confirmation, and durable success before advancing state. `requests_only`, `feed_only`, and `combined` are supported. The measured host can execute one already-claimed `/automation/execute`; the durable relayer scheduler remains unimplemented and production configuration keeps that lane disabled.             |
| Historical worker / relayer | `workers/nitro-worker`, `workers/morpheus-relayer`                               | Node compatibility only               | Not published by the production image workflow, not assigned `latest`, and not boot-enabled. Compose requires explicitly pinned `MORPHEUS_COMPAT_*` images; systemd requires `ENABLE_NODE_COMPAT`.                                                                                                                                                                                                        |
| Historical chain writers    | `deploy/feed-pusher/*` (including `*-testnet*`), `deploy/evm/neox-fulfiller.mjs` | Node compatibility only               | Every discovered writer/top-up/fulfiller unit — mainnet, testnet, or a future suffix — requires its lane `ENABLE_NODE_*_COMPAT` marker, has no `[Install]`, and `Conflicts=` / `Before=` both Rust relayer units. The NeoX fulfiller additionally exits 78 whenever `NODE_ENV=production`. A TestNet Node pusher is the same class of artifact as the mainnet Node pusher: it is not a production writer. |
| Edge feed / automation      | Cloudflare control plane                                                         | Non-authoritative ingress             | `/feeds/tick` returns 410 because Rust owns feed publication; `/automation/execute` returns 503 without creating a workflow while Rust automation remains fail-closed. Legacy bindings/classes are recovery metadata, not fallback authority.                                                                                                                                                             |

The frozen JavaScript parity baseline stays in the repository. It is test input
and rollback evidence, not an executable fallback inside a Rust service.

## Published images

`.github/workflows/publish-images.yml` builds only these service Dockerfiles:

- `deploy/nitro/Dockerfile.enclave`
- `deploy/nitro/Dockerfile.signer`
- `deploy/nitro/Dockerfile.relayer`

The workflow emits immutable `sha-<full-commit>` tags only. It emits no branch
tag, `latest`, legacy alias, Node worker image, or Node relayer image. Nitro
operators still rebuild and re-measure the host and signer EIFs with the exact
network/custody trust anchors; a registry rootfs tag is not a PCR approval.

The frontier measurement binds all six custody identities:

- `SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID`
- `SIGNER_ROLE_UPDATER_KEY_ID`
- `SIGNER_ROLE_RELAYER_KEY_ID`
- `SIGNER_ROLE_WORKER_KEY_ID`
- `SIGNER_ROLE_NEOX_UPDATER_KEY_ID`
- `SIGNER_ROLE_NEOX_VERIFIER_KEY_ID`

The two NeoX identities are deliberately non-interchangeable: the updater owns
EIP-1559 transaction submission, while the verifier owns semantic EIP-191
fulfillment proofs. The build refuses to measure an image if the ids are equal.

Changing any identity requires rebuilding the EIF, recording the new
measurement manifest, and updating the KMS/attestation policy as one release.

## Host layout

The production host runs the measured frontier and custody EIFs through:

- `morpheus-nitro-signer.service`
- `morpheus-nitro-custody.service`
- `morpheus-nitro-provision.service` and its credential-rotation timer

The launch/provision/build scripts use Bash, `curl`, `jq`, `nitro-cli`, and
`socat`; they do not require Node. Provisioning projects only allowlisted
fields, keeps credentials out of command-line arguments, and leaves existing
in-enclave credentials untouched when IMDSv2 rotation fails.

The Rust services still consume `NODE_ENV=production` as a legacy-named
deployment-mode contract: core, compute, and host use it to disable ephemeral
keys and unsafe overrides. Its presence in a Rust unit or image is therefore a
fail-closed safety input, not a Node runtime dependency. A future migration may
replace the name with a Rust-native deployment-mode key only after every
consumer has moved atomically.

`morpheus-nitro-egress.service` is a constrained host networking sidecar. Its
CONNECT allowlist is not a compute, custody, signing, transaction-building, or
broadcast authority. Replacing that helper is independent of the service
authority cutover and must not broaden the allowlist.

The Rust relayer is installed at
`/opt/neoos/services/bin/neo-os-relayer`.

The public Mainnet/TestNet registries are embedded in this binary. Runtime and
`config:validate` use the same reviewed registry without searching the current
directory or a source checkout. A registry update therefore requires rebuilding
the binary and recording its new digest.

Before enabling its production unit:

1. Copy `deploy/nitro/neo-os-relayer.env.example` to
   `/opt/morpheus/nitro/neo-os-relayer.env` and replace every placeholder.
2. Run `neo-os-relayer config:validate` as the service user.
3. Keep `MORPHEUS_AUTOMATION_ENABLED=false`; `config:validate` and
   `ensure_runtime_ready` refuse the service if the unavailable automation
   commit protocol is requested. `NODE_ENV=production` cannot opt in.
   Non-production may set `MORPHEUS_ALLOW_UNAVAILABLE_AUTOMATION=true` only
   as an explicit development allow.
4. Enable exactly one of `morpheus-relayer.service` or
   `morpheus-relayer-nitro.service`; the units conflict to prevent duplicate
   processing.
5. Keep every Node feed writer stopped — including
   `morpheus-feed-pusher-testnet*` — and remove all `ENABLE_NODE_*_COMPAT`
   markers. Those units have no `[Install]` target, so they cannot be
   `systemctl enable --now`'d. They `Conflicts=` / `Before=` both Rust
   relayer units as a second line of defense. Rust is the only production
   writer on mainnet and TestNet.

The relayer transport currently sends a bearer token to custody. Configure a
dedicated bearer caller for `SIGNER_SERVICE_TOKEN`; do not substitute a
`workload-ed25519` caller, which intentionally has no token and is not yet a
relayer authentication transport. Keep that caller distinct from
`MORPHEUS_RUNTIME_TOKEN`, which authenticates the relayer to the frontier host.

The Docker alternative is `docker-compose.rust.yml`. It requires an immutable
`neo-os-services-relayer:sha-...` image and runs the same configuration
preflight as its health check. Every other `docker-compose*.yml` file under
`deploy/nitro` is labelled Node compatibility and refuses to resolve without
pinned compatibility images.

## Release gates

Run:

```bash
npm run check:production-topology
npm run check:rust-migration
npm run check:cargo-lock-provenance
npm run format:rust:check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --all-targets --locked
```

`check:production-topology` prevents production workflow/systemd/Compose drift
back to Node authority, discovers every Node feed writer under `deploy/`,
rejects boot-enabled compatibility chain writers on any network suffix,
checks the Cloudflare feed/automation refusals, verifies both NeoX custody
anchors are measured, and keeps automation disabled in the production template.
The request/feed cutover is backed by real custody-to-broadcast, HALT/receipt
confirmation, durable state, restart, and failure-injection tests; changing a
label or image name alone would not have been a cutover.

## Feed writer discovery gate

### Overview

A hardcoded mainnet unit list is not an authority map. The topology gate walks
`deploy/` for every Node chain-writer `.service` / `.timer` and checks each
one. A future `morpheus-feed-pusher-<suffix>` file is in scope the moment it
lands; omitting TestNet from an allowlist is a failed audit, not a pass.

Writer units are names matching
`morpheus-feed-pusher*`, `morpheus-feed-topup*`, or `morpheus-neox-fulfiller*`
with a `.service` or `.timer` suffix. Freshness monitors and DB prune units
are not writers and are not in this set.

### API Reference

`scripts/check-rust-production-topology.mjs` exports:

| Symbol                                                      | Contract                                                                                                              |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `isNodeFeedWriterUnitName(fileName)`                        | True only for the writer name classes above                                                                           |
| `compatibilityMarkerForFeedWriter(fileName)`                | Lane marker: `ENABLE_NODE_FEED_PUSHER_COMPAT`, `ENABLE_NODE_FEE_TOPUP_COMPAT`, or `ENABLE_NODE_NEOX_FULFILLER_COMPAT` |
| `discoverNodeFeedWriterUnits(root)`                         | Recursive scan of `deploy/` for writer units                                                                          |
| `auditNodeFeedWriterTopology(root)`                         | Writer authority, compatibility marker, mutual exclusion, and enable posture                                          |
| `checkNodeFeedCompatUnit(name, source, marker)`             | Compatibility-only label, `ConditionPathExists` marker, `Conflicts=` / `Before=` both Rust relayers, no `[Install]`   |
| `checkRustFeedAuthorityUnit(name, source, writerUnitNames)` | Rust relayer `Conflicts=` every discovered writer basename                                                            |
| `checkWriterEnablePostureInDocs(name, source, writerStems)` | Operator docs must not `systemctl enable --now` a discovered writer                                                   |

Each Node writer must fail closed unless the operator creates the marker and
starts (never enables) the unit while both Rust relayers are stopped. CI does
not invoke `systemctl`; the gate is a strict unit-file parse.

### Usage Examples

```bash
npm run check:production-topology
node --test scripts/check-rust-production-topology.test.mjs
```

Regression fixtures live under `scripts/fixtures/feed-writer-topology/`:

- `missed-testnet-writer/` — compliant mainnet units plus a boot-enabled
  TestNet writer. A mainnet-only allowlist would pass; discovery must fail.
- `compliant-testnet-writer/` — TestNet units with marker, mutual exclusion,
  and no `[Install]`. Discovery must pass.

### Design decisions

1. **Rust is the only production writer.** Node feed-pusher / top-up /
   fulfiller units, including TestNet, are disabled compatibility artifacts.
2. **Discover, do not enumerate.** Hardcoding mainnet names produced a false
   pass while `morpheus-feed-pusher-testnet.service` remained enableable.
3. **Fail closed on enable posture.** No `[Install]` section, an explicit
   `ENABLE_NODE_*_COMPAT` path marker, and `Conflicts=` / `Before=` both
   `morpheus-relayer.service` and `morpheus-relayer-nitro.service`.
4. **Docs are in the same gate.** An `enable --now` instruction for a
   discovered writer is an audit failure even if the unit file is correct.

### Test Coverage

| Case                                 | Expected                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| Repository audit                     | `auditProductionTopology()` returns `[]`                                     |
| Discovery includes TestNet           | `morpheus-feed-pusher-testnet.*` is found under `deploy/`                    |
| Mainnet-only allowlist               | Fixture with a boot-enabled TestNet writer fails only when discovery is used |
| Compliant TestNet unit               | Marker + Conflicts/Before + no `[Install]` passes                            |
| Rust authority vs discovered writers | Missing `Conflicts=` on a discovered TestNet unit fails                      |
| Docs enable posture                  | `systemctl enable --now` of a writer stem fails the audit                    |
