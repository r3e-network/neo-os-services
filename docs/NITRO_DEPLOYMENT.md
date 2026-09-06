# AWS Nitro merged enclave deployment

The current service authority and compatibility boundary is defined in
[`PRODUCTION_RUST_TOPOLOGY.md`](./PRODUCTION_RUST_TOPOLOGY.md).

This runbook deploys the merged NeoOS compute-and-sign runtime into AWS Nitro.
The host relayer talks only to `127.0.0.1:8787`; that port is a vsock proxy into
the enclave.

The signing keys are **not** in that enclave. They live in a second one — the
custody enclave, CID 17 / host port 8789 — which
`docs/runbooks/custody-enclave-deployment.md` deploys. Consumers reach it
through `SIGNER_SERVICE_URL`, and so does the frontier: every Neo N3 signature
is custody-side.

## Files

- `workers/nitro-enclave-host` (binary `enclave_host`) implements the merged
  semantic compute and signing routes; `crates/nitro-attest` performs the
  KMS-attested provisioning.
- `crates/nitro-init` (binary `nitro_init`) is PID 1 of the image: loopback
  bring-up, the egress bridge, the server, the readiness gate, the vsock
  bridge, and fail-stop supervision of all three processes.
- `deploy/nitro/Dockerfile.enclave` builds the measured enclave image — those
  two Rust binaries plus `socat` and `iproute2`, and no JavaScript runtime.
- `deploy/nitro/enclave-server.mjs` is the pre-split Node implementation the
  Rust port is held against: `deploy/nitro/enclave-server.test.mjs` still gates
  it as the golden-vector reference, and the Rust parity tests cite it line by
  line. No image ships it and no unit runs it.
- `deploy/nitro/build-enclave-eif.sh` builds the EIF and measurement manifest.
- `deploy/nitro/start-nitro-signer.sh` runs the merged enclave and local bridge.
- `deploy/systemd/morpheus-nitro-signer.service` owns that enclave's lifecycle.
- `deploy/systemd/morpheus-relayer-nitro.service` starts the relayer against the
  local Nitro signer.
- Custody, deployed separately: `deploy/nitro/Dockerfile.signer`,
  `build-custody-eif.sh`, `start-nitro-custody.sh` and
  `deploy/systemd/morpheus-nitro-custody.service`.

All maintained production relayer, feed, and NeoX Docker/systemd/Compose
entries set `NODE_ENV=production` in the artifact or unit itself. This is a
legacy-named safety contract consumed by the Rust core/compute/host to reject
ephemeral keys and unsafe overrides; it does not imply a Node runtime. An env
file cannot silently downgrade the fail-closed production gates.

## Secret rendering

Run from the repo root:

```bash
npm run render:nitro-env -- --network mainnet --output-dir .secrets/nitro
```

The renderer reads the configured sources and refuses production output unless
the runtime-auth, updater and verifier KMS ciphertexts are present. It never
copies plaintext WIF/private-key fields into the provisioning artifact.

The generated files are local-only transport/provisioning inputs:

- `.secrets/nitro/morpheus-nitro-signer.env`
- `.secrets/nitro/neo-os-relayer.env`

`morpheus-nitro-signer.env` contains transport authentication plus KMS
CiphertextBlob values, never a WIF/private key. KMS policy must require the
published PCR measurement.

`neo-os-relayer.env` carries the relayer's custody signer configuration —
`SIGNER_SERVICE_URL`, a dedicated bearer-caller `SIGNER_SERVICE_TOKEN`, and
the lane-specific Neo N3 and NeoX role ids — sourced from the same inputs (set
them in `deploy/nitro/morpheus.<network>.env` or `.env`). The measured frontier
itself is built with all six mandatory roles: `UPDATER`, `ORACLE_VERIFIER`,
`RELAYER`, `WORKER`, `NEOX_UPDATER`, and `NEOX_VERIFIER`; `FEE_FUNDER` remains an
optional operational role outside that six-role readiness contract. A
`workload-ed25519` caller has no bearer token and is not yet a Rust relayer
authentication transport. The custody caller token must also remain distinct
from `MORPHEUS_RUNTIME_TOKEN`, which authenticates the frontier call. NeoX
updater and verifier roles are distinct authorities for EIP-1559 submission and
semantic EIP-191 fulfillment-proof signing, respectively.
Relayer Neo N3 signing is custody-only: the relayer reads no WIF, and
`scripts/check-nitro-env.mjs` fails a runtime env file that lacks the custody
provisioning. See `docs/SIGNER_SERVICE.md` §5 and §7.

## Frontier KMS and provisioning boundary

The parent instance role is a ciphertext carrier, not a secret reader. It must
not have `secretsmanager:GetSecretValue`, `kms:Encrypt`,
`kms:GenerateDataKey*`, or access to plaintext X25519/NeoDID masters. Grant only
the minimum `kms:Decrypt` operation needed to submit a Recipient request, and
make the KMS key policy require this release's PCR measurements. Ciphertexts
must be created offline by the release/security operator under credentials the
parent does not possess.

The Rust frontier unwraps these inputs with a fresh NSM Recipient attestation:

- `MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64`;
- `SIGNER_SERVICE_TOKEN_KMS_CIPHERTEXT_BASE64`;
- `MORPHEUS_ORACLE_KMS_CIPHERTEXT_BASE64`;
- `MORPHEUS_NEODID_SALT_KMS_CIPHERTEXT_BASE64`;
- optional `MORPHEUS_ORACLE_KMS_DIAG_CIPHERTEXT`.

The custody caller ciphertext plaintext is:

```json
{
  "purpose": "neoos/custody-caller-token/v1",
  "network": "mainnet",
  "version": 1,
  "token": "<distinct signer caller token>"
}
```

The X25519 ciphertext plaintext is:

```json
{
  "purpose": "neoos/oracle-x25519/v1",
  "network": "mainnet",
  "version": 1,
  "key_material": {
    "public_key_raw": "<base64-32-byte-X25519-public-key>",
    "private_key_pkcs8": "<base64-48-byte-PKCS8-private-key>"
  }
}
```

The NeoDID ciphertext plaintext is:

```json
{
  "purpose": "neoos/neodid-salt/v1",
  "network": "mainnet",
  "version": 1,
  "salt": "<at-least-32-byte-random-secret>"
}
```

`POST /provision` is one-shot. It accepts only those ciphertexts, temporary AWS
credentials/region, and the TwelveData provider credentials documented in
`docs/RUST_SERVICE_MIGRATION.md`; unknown names are rejected. Production mode,
network, endpoints, signer routing, feature switches, trust anchors, and
plaintext keys are immutable image configuration. The four-hour credential
refresh calls `POST /provision/credentials`, which accepts only
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_SESSION_TOKEN` under the
current runtime bearer. Key or runtime-token rotation requires a new enclave
boot and provisioning ceremony.

## Host install

```bash
sudo dnf install -y docker jq socat aws-nitro-enclaves-cli aws-nitro-enclaves-cli-devel
sudo systemctl enable --now docker nitro-enclaves-allocator
sudo install -d -m 0700 /opt/morpheus/nitro
sudo cp deploy/systemd/morpheus-nitro-signer.service /etc/systemd/system/
sudo cp deploy/systemd/morpheus-nitro-custody.service /etc/systemd/system/
sudo cp deploy/systemd/morpheus-nitro-egress.service /etc/systemd/system/
sudo cp deploy/systemd/morpheus-nitro-provision.service /etc/systemd/system/
sudo cp deploy/systemd/morpheus-nitro-provision.timer /etc/systemd/system/
sudo cp deploy/systemd/morpheus-relayer-nitro.service /etc/systemd/system/
sudo env MORPHEUS_NETWORK=mainnet \
  SIGNER_SERVICE_URL=https://custody.internal.example \
  SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID=<raw-verifier-key-id> \
  SIGNER_ROLE_UPDATER_KEY_ID=<raw-updater-key-id> \
  SIGNER_ROLE_RELAYER_KEY_ID=<raw-relayer-key-id> \
  SIGNER_ROLE_WORKER_KEY_ID=<raw-worker-key-id> \
  SIGNER_ROLE_NEOX_UPDATER_KEY_ID=<neox-updater-key-id> \
  SIGNER_ROLE_NEOX_VERIFIER_KEY_ID=<neox-verifier-key-id> \
  deploy/nitro/build-enclave-eif.sh --verify-reproducible
sudo env SIGNER_SERVICE_WORKLOAD_AUDIENCE=http://127.0.0.1:8789 \
  deploy/nitro/build-custody-eif.sh --verify-reproducible
sudo systemctl daemon-reload
sudo systemctl enable --now morpheus-nitro-egress
sudo systemctl enable --now morpheus-nitro-signer
curl -fsS http://127.0.0.1:8787/health
sudo systemctl enable --now morpheus-nitro-custody
curl -fsS http://127.0.0.1:8789/health
sudo systemctl enable --now morpheus-nitro-provision.timer
```

The custody workload audience is measured into its EIF and must exactly match
the canonical origin configured in NeoNexus. The loopback value above matches
the default host bridge. Build with the external HTTPS origin instead when a
TLS proxy is the caller-visible custody endpoint; changing it requires a new
measurement and KMS policy pin.

The Rust relayer is installed with the other Rust service artifacts as the
production request/feed delivery authority:

```bash
cargo build --release --locked -p neo-os-relayer --bin neo-os-relayer
sudo install -d -m 0755 /opt/neoos/services/bin
sudo install -m 0755 target/release/neo-os-relayer /opt/neoos/services/bin/neo-os-relayer
sudo install -m 0640 deploy/nitro/neo-os-relayer.env.example /opt/morpheus/nitro/neo-os-relayer.env
sudoedit /opt/morpheus/nitro/neo-os-relayer.env

sudo systemctl daemon-reload
sudo systemctl enable --now morpheus-relayer-nitro
```

Choose `neo_n3`, `neox`, or both in `MORPHEUS_ACTIVE_CHAINS`, and select
`requests_only`, `feed_only`, or `combined`. Feed modes require
`MORPHEUS_FEED_SYNC_ENABLED=true`, at least one symbol, and each active chain's
datafeed contract. Request modes require the active chain's oracle contract.
All modes use the measured host and separate custody service. Keep
`MORPHEUS_AUTOMATION_ENABLED=false`; `config:validate` fails closed otherwise.

The egress unit is not optional for custody: `morpheus-nitro-custody.service`
orders itself after it, and a `Wants=` on a unit that was never installed is
silently ignored — the symptom shows up later as `503 signer-provision-failed`,
because the KMS `Decrypt` during `/provision` has no way out of the enclave.

That last `curl` returning 200 is not proof the vault is open. Until the KMS key
policy admits this release's PCR0 and
`/opt/morpheus/nitro/morpheus-custody-signer.env` exists, `/health` answers
`{"status":"unprovisioned"}` and every custody route refuses with 503. Both are
the custody runbook's job (`docs/runbooks/custody-enclave-deployment.md`).

The frontier build command is network-specific. `MORPHEUS_NETWORK` becomes an
EIF build argument and therefore contributes to PCR0; `/provision` cannot
change it. Build and publish distinct measured artifacts for mainnet and
testnet.

## Safety

`MORPHEUS_ALLOW_UNPINNED_SIGNERS=true` never belongs in a runtime env file on any
network — `scripts/check-nitro-env.mjs` fails a file that carries it, so a deployment
that renders it true stops before the enclave boots. Only the bootstrap files under
`.secrets/` may set it. If the renderer cannot find the pinned updater/verifier
material, stop and recover the correct signer or perform an explicit on-chain role
rotation.
