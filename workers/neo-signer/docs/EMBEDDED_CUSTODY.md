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

# Offline Testnet material preparation (separate operator example)

`prepare_testnet_material` is a standalone, explicitly invoked Cargo example;
the runtime image does not run it. It prepares a **new Testnet identity** only.
No old Testnet root is required. It does not open a state database, perform
enrollment, sign, change CMK/role policy, produce an EIF, or provision a service.
Preserved Mainnet inputs remain a separate requirement of the dual builder.
New source and recipe bytes require their own later source freeze/measurement.

The two subcommands have a fixed positional interface:

```text
prepare PLAN_ABSOLUTE EXPECTED_PLAN_SHA256 PUBLIC_DIR PRIVATE_FD PRIVATE_FILE
seal    PLAN_ABSOLUTE EXPECTED_PLAN_SHA256 PUBLIC_DIR PRIVATE_FD PRIVATE_FILE EXPECTED_PREPARED_SHA256 CIPHERTEXT_DIR APPROVED_AWS_CLI_ABSOLUTE
```

This is a future ceremony contract, not permission to execute these commands.
Only synthetic fixtures/fake entropy/fake child are used by source tests.
There is no implicit/default subcommand, implicit path, mutable-tag lookup,
retry, development root, secret argv/env, or automatic second generation.

The bounded strict plan schema is `neoos/testnet-material-plan/v1`. Fields are
`schema`, `environment` (exact `testnet`), `source_commit`, `source_tree` (40
lower-hex each), `ceremony_id`, `caller_id`, `caller_label`, `vault_id`,
`root_key_version`, `networks`, `custody_kms_key_arn`, and `coordinator` (the
existing native coordinator shape). Unknown/duplicate fields, root/digest or
purpose/context overrides refuse. The supplied expected SHA pins the **raw**
plan bytes. Source commit/tree are declared plan identity; they require an
independent source/binary provenance review, not trust in this declaration.
The receipt additionally binds the exact example/provision source bytes
embedded at compilation. These source hashes do not replace the source freeze.

Before any entropy or output write, native validation checks the plan and
the tool enforces the dual builder's stricter Testnet contract: exactly BOTH
sorted `neo-n3`/`neox` bindings, reviewed Testnet chain IDs, and the checked-in
N3 genesis. A syntactically valid alternate N3 genesis is refused. The fixed
CMK is `arn:aws:kms:us-east-1:736326664265:key/821b2d72-4774-412c-8e8a-7ca9487ab8ac`
and region is `us-east-1`; no Mainnet profile is opened/emitted. No source or
policy pins are refreshed by this tool.

The first implementation supports a regular **file-backed private holder**.
The authorized preparer must separately create a fresh owner-only directory
(0700) and a single-link regular empty file (0600), open it on descriptor >2,
and supply its absolute canonical path. Do not place private material in a
repository, evidence, runtime or home configuration directory. Path components
must not be symlinks; file owner/type/mode/link/inode and the opened descriptor
are checked. Stdout/stderr/stdin, hardlinks, duplicate open descriptor aliases,
wrong access mode and overwrites refuse. Ownership of the supplied descriptor
is transferred to the tool; do not use it afterward. No pipe/TTY/holder
acknowledgement protocol is inferred as durable storage.

`prepare` uses fallible OS entropy for exactly one raw 32-byte root and two
distinct `nsk1_` credentials in the existing two-v4-UUID format (244 random
bits per token, not a claim of 256). Root commitment is the existing native
domain-separated commitment over the raw bytes; Admin/transport digests are
SHA-256 over their exact UTF-8 bytes. The private bundle is never a public
artifact. It is fully written, synced and closed, with parent directory sync,
before publishing `testnet.json` and `testnet-enrollment.json`. The exact
enrollment bytes are finalized first and their raw SHA becomes
`release_policy_version`. Both actual native validators are applied.

`PREPARED.json` is the last preparation output. It binds the original transport
digest as well as Admin digest, root commitment, ceremony/time, source/plan,
Testnet networks, raw profile/enrollment hashes and native profile/network-set
hashes. Independently freeze its SHA **outside the private bundle** before
sealing; recomputing a new hash beside a substituted token is not approval.
`seal` requires that exact expected receipt SHA and rederives/compares the
complete receipt plus exact public files before any child/Encrypt operation.
A transport-only replacement therefore refuses even if root/Admin/profile
and enrollment remain unchanged.

The private input is read into bounded zeroizing memory and closed before
any child spawn; its original descriptor is marked CLOEXEC immediately on
ownership transfer. Any other inheritable nonstandard descriptor refuses.
Rust-opened output descriptors are CLOEXEC, and no open private file is passed
to the child. The child receives only **one purpose-selected request** on its
own stdin pipe. This is descriptor hygiene, not a sandbox against a malicious
same-user approved executable reading the holder path; binary provenance and
the authorized preparation identity remain prerequisites.

The later `seal` operation requires an existing approved AWS CLI v2 executable
and explicit temporary `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`AWS_SESSION_TOKEN` in the tool process. The adapter clears the child's ambient
environment and passes only these three authentication names plus its fixed
CLI settings. It does not use ambient AWS profiles/config/credential files,
metadata identity, proxy or endpoint overrides. No credentials are read by
`prepare`. AWS CLI absence or denied Encrypt is a future transport prerequisite,
not an instruction to install, acquire credentials or expand policy.

The adapter executes no shell. It pins `kms encrypt`, `--cli-input-json
file:///dev/stdin`, `--cli-binary-format base64`, official
`https://kms.us-east-1.amazonaws.com`, region `us-east-1`, JSON output, no pager,
5/10-second connect/read timeouts, one AWS attempt and a 20-second child bound.
Raw plaintext is base64 encoded once in JSON; it is not sent as a hash, hex,
argv, environment variable, request file or entire private bundle. Real
AWS CLI encoding behavior and actual Recipient release remain later transport
qualifications; a synthetic fake-child roundtrip does not prove either.

All three purposes use `custody_encryption_context`, the same exact six fields
as production Recipient-bound Decrypt: component, typed purpose, vault ID,
native profile SHA, native network-set SHA and root-version. Purpose values
are `master-key/v1`, `transport-token/v1`, `first-admin/v1`; the full pinned
CMK is KeyId, not an additional context field. No legacy/context-free fallback
or PCR/context/schema change is introduced.

`seal` validates returned KeyId/algorithm and bounded nonempty canonical base64
ciphertext, rejects duplicate decoded ciphertext, and durably writes each
ciphertext to a fresh private 0700 directory (files 0600). `SEALED.json` is
published last after all three retained artifacts. Any failed/ambiguous call,
write, sync or close makes the attempt ineligible; preserve protected partial
evidence and the failure, do not regenerate/retry automatically. Failed receipt
publication attempts remove the incomplete marker on a best-effort basis.
If storage also refuses cleanup, existing marker bytes MUST NOT be treated as
completion: the operation's failure and lack of successful durability result
are controlling, and require independent reconciliation. A file's existence
alone is never eligibility. Successful output files are not overwritten.

Only completed actual commitments/digests/public files may feed premeasurement.
Do not substitute placeholders after measuring. Retain actual transport/Admin
tokens privately for their distinct later uses; the enclave does not return
the Admin token. Raw-root retirement belongs to the separately reviewed custody
retention/recovery procedure; unlink is not a forensic-erasure guarantee.
Named role IDs/UUID alternatives, first-Admin committed recovery, preserved
Mainnet continuity, new measurements, admission and runtime release are
separate gates and are not closed by this source tool.
