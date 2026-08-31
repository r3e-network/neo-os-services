# Custody Enclave Deployment Runbook

Operator walkthrough for the Nitro enclave that holds the signer service's
vault: the Rust `signer_service` binary inside the `Dockerfile.signer` image,
measured by `build-custody-eif.sh`, started and provisioned by
`start-nitro-custody.sh`. The service contract is
`docs/SIGNER_SERVICE.md` (§5.2 records the enclave routes this flow uses).

Nothing in this runbook is executable on a developer workstation: every step
from "Build the EIF" onward needs a Nitro-capable AL2 host (nitro-cli, the NSM
device, and an instance role whose KMS key policy admits it). Steps marked
**verify by hand** cannot be automated by the scripts and are the operator's
responsibility on the box.

## What the enclave runs

- `Dockerfile.signer` — two stages; the last (measured) one is
  `debian:bookworm-slim` plus the two Rust binaries, `socat`, `iproute2`, the
  entrypoint, and nothing else. No Node runtime exists in the enclave.
- `deploy/nitro/entrypoint-custody.sh` — brings loopback up (an enclave boots
  with `lo` DOWN), starts the egress bridge (127.0.0.1:3128 → vsock
  CID 3:8788, the parent's allow-listed CONNECT proxy), starts
  `signer_service serve` (attested boot is baked in), readiness-probes it,
  then bridges vsock 8787 → 127.0.0.1:8081. Fail-stop: if any of the three
  processes dies, the whole enclave tears down.
- `deploy/nitro/start-nitro-custody.sh` — the host side: terminates any enclave
  already holding the CID, runs the EIF, bridges host port 8787 → vsock 8787,
  waits for `/health`, then provisions (below).

## KMS setup (one-time per enclave release)

The master key and the transport token envelope are released through the
attested KMS path: the enclave sends `kms:Decrypt` with a Recipient
`RecipientAttestation` containing a fresh NSM attestation document, and KMS
releases the plaintext only if the document's PCR0 matches the key policy.

1. Create (or rotate to) a KMS symmetric key dedicated to custody, and set a
   key policy condition on the `kms:Decrypt` action:
   `kms:RecipientAttestation:ImageSha384` equal to the **PCR0 of the release
   you are deploying**, plus
   `kms:RecipientAttestation:PCR0BeforeSha384`/`PCR1`/`PCR2` variants if your
   policy template uses them. The authoritative PCR0 pin lives here — not in
   the image, because baking the pin into the image would change the PCR0 it
   pins (see `docs/SIGNER_SERVICE.md` §5.2).
2. Seal the two envelopes with that key (plain `aws kms encrypt`, this runs on
   the operator machine):
   - `MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64` — the transport token, a
     printable-ASCII string, 8-512 characters. The enclave validates the
     Bearer token presented at `/provision` against this envelope.
   - `SIGNER_SERVICE_MASTER_KEY_KMS_CIPHERTEXT` — 32 random bytes. This is the
     vault master key; treat it with the same care as a WIF, because whoever
     releases it owns every key the vault seals under it.
     Both values land base64-encoded in the signer env file.
3. Ensure the instance role running the host can `kms:Decrypt` that key — the
   policy's principal is the role whose credentials `start-nitro-custody.sh`
   fetches from IMDSv2.

## Preparing the provisioning env file

`/opt/morpheus/nitro/morpheus-custody-signer.env` (override with
`MORPHEUS_CUSTODY_SIGNER_ENV`):

```
# The transport token, presented as Bearer by /provision and validated
# against its envelope. Printable ASCII, 8-512 chars.
MORPHEUS_RUNTIME_TOKEN=<token>
# The two KMS ciphertexts, base64, sealed under the custody key.
MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64=<base64>
SIGNER_SERVICE_MASTER_KEY_KMS_CIPHERTEXT=<base64>
# Region, when not derivable from AWS_REGION.
SIGNER_SERVICE_KMS_REGION=<region>
```

The start script refuses the file outright if it contains a plaintext
`SIGNER_SERVICE_MASTER_KEY=` line (RC2 — the enclave refuses it a second time,
at its own `/provision`, with 403 `signer-provision-forbidden`), or the retired
`MORPHEUS_ALLOW_PLAINTEXT_KEY_PROVISION=`. Only the whitelisted names above are
projected into the provision body; everything else in the file stays on the
host (the enclave would refuse unknown keys with 400 anyway).

## Build the EIF and pin the measurements

On the Nitro host (node present — it runs the host-side services):

```sh
MORPHEUS_RELEASE=custody-$(date -u +%F) \
  deploy/nitro/build-custody-eif.sh --verify-reproducible
```

`--verify-reproducible` builds the image twice and asserts identical PCRs —
the authoritative reproducibility gate (equal PCRs ⇔ reproducible enclave;
Docker image IDs are not a valid signal). The script writes
`deploy/nitro/measurements/<release>.json` and refuses to write a manifest
with empty PCRs.

**Verify by hand:** read the manifest before committing it — release, network,
git commit — and confirm the PCR0 matches what the KMS key policy pins. The
boot report and `GET /attestation` both surface the measured PCR0; if they
disagree with the manifest, stop.

## Start and provision

```sh
deploy/nitro/start-nitro-custody.sh
```

On success the script prints `{"status":"ok","vault_fingerprint":"…"}`. Between
enclave start and a successful provision, `/health` answers
`{"status":"unprovisioned"}` and every custody/management route answers
`503 signer-not-provisioned` — the sealed window (§5.2). Provisioning happens
once per boot; a second call answers `409 signer-provision-already-done`. The
window is as short as the readiness loop plus one provision round-trip.

**Verify by hand:** `curl -s http://127.0.0.1:8787/health` says `ok`, and the
fingerprint is the one you expect for the master key you sealed (the
fingerprint is SHA-256 of the key, truncated — it identifies the key without
being derived from anything signable).

## Attestation check (what a remote verifier does)

```sh
NONCE=$(openssl rand -hex 16)
curl -s "http://127.0.0.1:8787/attestation?nonce=$NONCE" | jq .
```

The reply carries the vault fingerprint, the boundary JSON with its
`boundaries_sha256`, the echoed nonce, and `attestation_document` (base64 COSE
Sign1). A verifier confirms: PCRs match the committed manifest, the nonce was
the one it supplied, `user_data` decodes to
`{"runtime":"neo-signer-custody","vault":…,"boundaries_sha256":…}` and the
digest equals SHA-256 of the boundary JSON in the reply. The same check runs
without a nonce for a quick liveness read.

## Failures worth knowing by name

- **Enclave exits at boot, log says `attested boot refused`** — the boot guard
  could not answer the NSM (wrong image, non-Nitro host, or the device is
  missing). This is fail-closed behavior; the custody image refuses to serve
  anywhere but inside a Nitro enclave.
- **`503 signer-provision-failed`** — the KMS release failed: key policy,
  region, or instance-role credentials. The detail names the HTTP failure; the
  instance credentials are fetched fresh from IMDSv2 each run, so a role
  change takes effect on the next start.
- **`401 signer-provision-unauthorized`** — the Bearer token does not match the
  released envelope. The token in the env file and the token sealed in
  `MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64` must be the same string.
- **The enclave dies if one process dies** — the entrypoint fail-stops on
  purpose. `nitro-cli console --enclave-id <id>` shows the entrypoint's stderr;
  the boot report (bound address, vault state, measured PCR0) is there.

## Ephemeral state (read this before an enclave restart)

The enclave's rootfs is memory-backed: terminating the enclave destroys the
database, the audit trail, and every key row minted inside it. The master key
survives only as its KMS ciphertext. Consequences:

- Every boot starts sealed and needs `/provision` again (fresh envelopes are
  not required — the same ciphertexts release again).
- Keys minted _inside_ the enclave after boot exist only in enclave memory;
  re-create them (or re-import) after each restart, through a caller you also
  re-create. This is the known limitation the consumer migration (§7 step 3)
  plans to close; until then treat enclave restarts as maintenance windows.
- Key secrets at rest are sealed under the master key and caller tokens are
  stored as digests only, so a vault directory prepared on a host is safe to
  carry — the portability that the eventual state-restore flow builds on.
- The enclave-born fallback (booting without
  `SIGNER_SERVICE_MASTER_KEY_KMS_CIPHERTEXT` and letting the vault generate a
  master key into its data dir) is even more volatile: the key dies with the
  enclave, so every key it ever sealed is lost. It exists for experiments; do
  not use it for a deployment with consumers.
