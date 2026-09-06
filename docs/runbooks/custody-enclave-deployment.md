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
  `debian:bookworm-slim` plus the three Rust binaries, `socat`, `iproute2`,
  `libcap2-bin` (present only so the layer can run `setcap`), and nothing else. No
  Node runtime and no `/bin/sh` entrypoint exist in the enclave.
- `/app/bin/nitro_init custody` (`crates/nitro-init`) — PID 1: brings loopback up,
  starts the egress bridge (127.0.0.1:3128 → vsock CID 3:8788, the parent's
  allow-listed CONNECT proxy), starts `signer_service serve` (attested boot is baked
  in), readiness-probes it over loopback, then bridges vsock 8787 → 127.0.0.1:8081.
  Fail-stop: if any of the three processes dies, the whole enclave tears down. The
  POSIX shell it replaced, `deploy/nitro/entrypoint-custody.sh`, lives in git history.
- **Verify by hand:** PID 1 runs as uid 8021, and an unprivileged process cannot bring
  an interface up — so `Dockerfile.signer` grants the `ip` binary the
  `cap_net_admin+ep` file capability and leaves every other one with none. Whether
  that capability survives to runtime is the open part: it needs the
  `security.capable` xattr to come through `nitro-cli` flattening the rootfs into the
  EIF, and the rootfs to be mounted without `nosuid` (a nosuid mount ignores file
  capabilities). Check both from inside the first booted enclave with
  `getcap "$(command -v ip)"`. The boot is correct under either answer as long as the
  enclave kernel left `lo` up on its own, in which case the `ip` call is a no-op. If
  the capability did not survive and `lo` is down, the readiness probe never connects
  and the boot aborts — `nitro-init: signer_service ready; exposing over vsock :8787`
  is the line that proves it worked — and the remaining fix is to run PID 1 as root,
  which changes the measurement.
- `deploy/nitro/start-nitro-custody.sh` — the host side: terminates any enclave
  already holding the CID, runs the EIF, bridges host port 8789 → vsock 8787,
  waits for `/health`, then provisions (below).
- **The CID and host port are not the frontier's.** A host runs two enclaves: the
  frontier (`start-nitro-signer.sh`, `morpheus-oracle.eif`, built from
  `Dockerfile.enclave`) on CID 16 / host port 8787 — the endpoint
  `MORPHEUS_RUNTIME_URL`, `NITRO_API_URL` and the feed-pusher's `SIGNER_URL` all
  name, and where `provision-enclave-compute.sh` pushes the compute config — and
  custody on CID 17 / host port 8789. Both are set in
  `deploy/nitro/morpheus-nitro.env.example`, which is the `EnvironmentFile` of
  both units. They have to differ: the start script terminates whatever enclave
  holds its CID before booting, so a shared CID means killing the frontier and
  answering its consumers with a vault, and a shared host port means the second
  socat bridge cannot bind. `start-nitro-custody.sh` refuses either — but only
  when the frontier's value is actually declared (`MORPHEUS_NITRO_CID` /
  `MORPHEUS_NITRO_HOST_PORT`), so a custody-only host is still free to use 16 and 8787. The vsock port stays 8787 on both: it is per-enclave, and it is what
  `NITRO_SIGNER_VSOCK_PORT` inside the measured image declares, so changing it
  changes PCR0.

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

The host role is deliberately decrypt-only at this boundary. Do not grant it
`secretsmanager:GetSecretValue`, `kms:Encrypt`, `kms:ReEncrypt*`, or
`kms:GenerateDataKey*`. Ciphertext creation is an offline release-operator
ceremony under a different principal. Otherwise a compromised parent could
encrypt attacker-known plaintext and ask an admitted enclave to install it,
which would defeat the recipient-attestation boundary without breaking KMS.

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
  SIGNER_SERVICE_WORKLOAD_AUDIENCE=http://127.0.0.1:8789 \
  deploy/nitro/build-custody-eif.sh --verify-reproducible
```

`SIGNER_SERVICE_WORKLOAD_AUDIENCE` is the exact canonical origin NeoNexus puts
in `X-NeoOS-Audience`. It names the caller-visible host bridge or TLS endpoint,
not the enclave's private `127.0.0.1:8081` listener. The build script defaults it
to `http://127.0.0.1:${MORPHEUS_CUSTODY_HOST_PORT:-8789}`; set it explicitly for
an external TLS origin. It is baked into the EIF because Nitro cannot inject a
process environment at `run-enclave`, so changing the origin or host port
requires rebuilding, remeasuring, and repinning the KMS policy. Adding it to the
later `/provision` body would be too late: the signer fixes its authentication
policy before it accepts that request.

`--verify-reproducible` rebuilds the image with `--no-cache` and asserts identical
PCRs — the authoritative reproducibility gate (equal PCRs ⇔ reproducible enclave;
Docker image IDs are not a valid signal). The rebuild is uncached on purpose:
BuildKit's layer cache is keyed on content rather than on the tag, so a second
plain `docker build` replays the first build's layers byte-for-byte and the
comparison can never fail. Expect a second full Rust compile. Both stages pull a
resolved `@sha256` base, so that rebuild is the whole story — bumping a base digest
is itself a re-measurement, not a routine dependency update. Omitting
the flag still writes a manifest, but prints a warning first, because that PCR0
is about to become a KMS key-policy condition nobody reproduced. The script
refuses to write a manifest with empty PCRs either way.

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

**Verify by hand:** `curl -s http://127.0.0.1:8789/health` says `ok`, and the
fingerprint is the one you expect for the master key you sealed (the
fingerprint is SHA-256 of the key, truncated — it identifies the key without
being derived from anything signable).

## Supervision (systemd)

Run by hand, the script stays in the foreground — it ends in `wait` on the socat
bridge, which is what keeps the enclave reachable — so it dies with your
terminal, and nothing brings the enclave back after a reboot or a crash. That
matters more here than for the frontier: the rootfs is memory-backed, so every
boot starts sealed, and an unsupervised crash therefore leaves a host whose
custody routes answer `503 signer-not-provisioned` indefinitely while the
consumers that sign through it (relayer, worker, feed-pusher) fail with it.

`deploy/systemd/morpheus-nitro-custody.service` owns that lifecycle:

```sh
sudo cp deploy/systemd/morpheus-nitro-custody.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now morpheus-nitro-custody.service
journalctl -u morpheus-nitro-custody.service -f
```

It is a **peer** of `morpheus-nitro-signer.service`, not a replacement: the two
units run the two enclaves on their own CID and port, and the frontier's
dependents (`morpheus-nitro-kms-proxy`, `morpheus-nitro-provision`,
`morpheus-relayer-nitro`) keep pointing at the frontier unit alone. Custody
orders itself after `morpheus-nitro-egress.service` instead, because the KMS
`Decrypt` that `/provision` performs leaves through the parent's allow-listed
CONNECT proxy — not through the vsock KMS proxy on 8001, which serves the
frontier's in-enclave kmstool path.

## Attestation check (what a remote verifier does)

```sh
NONCE=$(openssl rand -hex 16)
curl -s "http://127.0.0.1:8789/attestation?nonce=$NONCE" | jq .
```

The reply carries the vault fingerprint, the boundary JSON with its
`boundaries_sha256`, the echoed nonce, and `attestation_document` (base64 COSE
Sign1). A verifier confirms: PCRs match the committed manifest, the nonce was
the one it supplied, `user_data` decodes to
`{"runtime":"neo-signer-custody","vault":…,"boundaries_sha256":…}` and the
digest equals SHA-256 of the boundary JSON in the reply. The same check runs
without a nonce for a quick liveness read.

Each boundary entry includes both the network label and numeric
`network_magic`; verify both against the intended chain. A magic-only change
must change `boundaries_sha256`.

## Provision dedicated raw-only roles

The frontier's `worker`, updater-compatibility, or other digest lanes must not
reuse a transaction/consensus authority key. For each required raw lane:

1. generate/import a dedicated key;
2. save a policy with `allow_raw: true` and all of `allow_consensus`,
   `allow_transfer`, `allow_contract_call`, and `allow_global_scope` false;
3. create a caller granted only that key and capability `raw_sign`;
4. bind the role key id into the frontier EIF build, then seal the caller token
   as the `neoos/custody-caller-token/v1` network/version envelope and place
   only its ciphertext in the frontier signer env as
   `SIGNER_SERVICE_TOKEN_KMS_CIPHERTEXT_BASE64`.

The signer rejects a mixed raw/semantic policy, and `/sign/raw` rejects a
caller that has only `sign`. The collision preimage
`networkMagicLE || SHA256(unsignedTransaction)` is therefore not signable by a
semantic authority key.

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
