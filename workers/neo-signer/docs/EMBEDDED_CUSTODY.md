# Embedded attested custody

`neo_signer::embedded::EmbeddedCustodyRuntime` boots one immutable public-network
vault inside an existing business process. It creates no listener or process.
The embedding application supplies independent profiles, data directories,
audiences and ingress routing for MainNet and TestNet.

```rust,no_run
use std::{path::PathBuf, sync::Arc};
use neo_signer::{attestation::BootGuard, embedded::{EmbeddedCustodyConfig,
    EmbeddedCustodyRuntime}, network::Network, vault_profile::VaultProfile};
# fn example(bytes: &[u8]) -> anyhow::Result<()> {
let runtime = EmbeddedCustodyRuntime::boot(EmbeddedCustodyConfig {
    enrollment: None,
    profile: Arc::new(VaultProfile::from_json(bytes)?),
    expected_network: Network::Testnet,
    data_dir: PathBuf::from("/data/custody/testnet"),
    workload_audience: "https://custody.test.example".into(),
    max_body_bytes: 256 * 1024,
    max_in_flight_requests: 16,
}, BootGuard::required(None)?)?;
let router = runtime.router();
assert_eq!(runtime.expected_network(), Network::Testnet);
# drop(router);
# Ok(()) }
```

`boot` requires a fresh nonce-bearing NSM attestation. The optional PCR0 pin is
validated by `BootGuard::required`; the authoritative production pin remains in
KMS policy. `boot_with_attestation_source` exercises the identical guard with an
explicit source, allowing synthetic attestation tests without NSM or KMS. Such
tests do not establish hardware attestation or production readiness.

The bootstrap rejects an expected-network/profile mismatch, non-public network,
invalid audience, zero or excessive limits, plaintext master-key environment or
file, an occupied data directory, and a failed boot proof. No local master key
is opened or generated. It returns a sealed router: `/health` reports
`unprovisioned`, and signing returns `503 signer-not-provisioned` until the
existing `/provision` path releases the root and verifies/reconstructs durable
state. A failed provision stays sealed; a second successful provision is refused.
No environment switch can turn this bootstrap into development mode.

The router uses native signer paths (`/health`, `/provision`, `/signer/api/v1/...`).
An embedding frontend must expose provisioning in its separately authorized
namespace and explicitly allow only its intended custody operations. Pass the
original authentication headers and body unchanged; do not pre-consume workload
assertions. Existing authentication, policy, replay protection, audit and durable
`execute_observable` processing run once. Keys must match the admitted profile's
network, chain family and chain ID before signing or returning a cached witness.
Key creation/import is constrained to the same profile.

Every runtime, router, pending provision and recovered service clone retains the
OS data-directory lock. Started blocking work retains it after request
cancellation. No method returns `ApiState`, a service, or root/key material.
The optional `signclient_bridge` factory exists to preserve the standalone
binary's existing adapter; it does not start a listener.

Dispatch the router asynchronously with Tower, or provide enough bounded Tokio
blocking capacity for an outer synchronous adapter plus the router's nested
blocking work. Holding every blocking worker while waiting on nested work will
deadlock. Ingress and internal permits remain bounded and health bypasses the
custody admission budget. Bootstrap performs synchronous NSM and filesystem work
once; each request uses the existing bounded blocking implementation.

The standalone attested binary shares this bootstrap. Its environment parser is
still the standalone configuration adapter, with its legacy workload migration setting available only in host mode.
Attested standalone and embedded boot require v2 audience binding. Integrating this API alone does not establish a measured dual-network
image, network egress authorization, KMS permissions or deployment acceptance.

## Measured TestNet first Admin

Enrollment is an explicit image configuration, not a management route. It is
available only for a new exclusively admitted TestNet profile. The authority
must never have admitted an incompatible producer to that profile/root scope;
changing PCR admission alone does not revoke previously issued sessions,
challenges or leases. Unknown historical genesis and Admin-less snapshots are
not migrations supported by this mechanism. MainNet cannot opt in.

The reviewed dual-image input may add `enrollment` to its `testnet` entry:
`{"mode":"first-testnet-admin/v1","manifest_file":"testnet-enrollment.json",
"manifest_sha256":"<exact lowercase SHA-256>"}`. The builder stages that bounded
public file with both default and cross images, bakes its mode/path/hash into
the measured network map, and reads back the exported file. The profile's
`release_policy_version` must equal the same digest. `dual_prepare` and runtime
boot both call the same Rust validation. A digest-shaped policy without the
explicit opt-in does not enable enrollment. Runtime provision bodies cannot
replace the mode, manifest, map or profile.

The manifest is at most 16 KiB, has no unknown or duplicate fields, and uses:

- `schema`: `neoos/first-admin-enrollment/v1`; `purpose`: `first-testnet-admin/v1`.
- `ceremony_id`: fixed ASCII identifier (1–128 alphanumeric, `_` or `-`).
- Exact profile destination fields: `environment`, `vault_id`, `networks`,
  `custody_kms_key_arn`, `root_key_version`, `root_key_commitment`, `coordinator`.
- `caller`: fixed `id`, `label`, positive `created_at_unix`, lowercase SHA-256
  `token_digest`, `auth_mode: "bearer"`, `capabilities: ["admin"]`,
  `key_grant: "any"`, `allowed_origins: []`, `disabled: false`.

The file contains neither plaintext credentials nor the final profile hash.
Hash exact file bytes first, put that digest in the profile, then derive the
canonical profile hash and encrypt the independently retained Admin token under
that profile's KMS context. The token has the existing `nsk1_` plus 64 lowercase
hex format. `/custody/provision` accepts the additional ciphertext environment
field `SIGNER_SERVICE_FIRST_ADMIN_KMS_CIPHERTEXT` only for configured enrollment.
Trusted code selects the new `first-admin/v1` KMS purpose; it never accepts a
purpose from the request. Ciphertext bytes must differ from root and transport
envelopes, and plaintext must match the manifest digest and differ from the
transport token. No initial credential is returned or persisted in plaintext.

Authenticated HEAD recovery selects the branch before releasing the Admin
credential. On absent or exact generation-zero HEAD, takeover must acquire the
fenced lease. Only this opted-in scope may resume initialized genesis after an
expired owner. All application tables must be empty; the fixed caller and audit
receipt are inserted atomically. The service stays private until the encrypted
initial snapshot is durably committed and the signed authority receipt verifies.
The enrollment audit is inside the snapshot; the authority receipt is stored
atomically alongside HEAD by the existing authority protocol.

Failed initialization preserves the local database and keeps that boot sealed.
Same-owner network retries use the existing exact candidate/commit ID; a fresh
boot requires a new local target and authoritative recovery. Generation one
restoration checks exact initial rows. Later restoration checks historical
enrollment evidence and usable Admin access while preserving legitimate caller
rotation. Committed restoration never invokes initial credential release and
may omit its ciphertext entirely. Missing Admin access is refused, never repaired
by rerunning enrollment. Existing non-enrollment profile and snapshot semantics
remain unchanged.
