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
