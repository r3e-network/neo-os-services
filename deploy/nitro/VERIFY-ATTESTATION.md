# Verifying the Morpheus Oracle TEE enclave

> **⚠️ What runs today cannot be rebuilt (2026-09-23).** The live mainnet enclave
> attests the PCRs of **`oracle-enclave-exec-2026-06-15.10`**
> (PCR0 `39fad73b3d3c528b2a176b0bdf6a6761810a0c5e1a548b5fe589e98feb448b38016bbe56939d52db873086f294dcba7c`,
> `git_commit` `1218f7c`,
> `deploy/nitro/measurements/oracle-enclave-exec-2026-06-15.10.json`), measured from the
> public runtime endpoint on 2026-09-23 and recorded in
> `apps/web/lib/attestation/recorded-mainnet-attestation-2026-09-23.json`. No fetched
> branch of this repository reaches `1218f7c`, or the `git_commit` of any other committed
> manifest, so path A below cannot be carried out for any committed release: there is no
> tree to check out. The verifier (`/api/attestation/verify`, `/verifier`) therefore pins
> nothing and reports the running enclave as `measured-but-unreproducible`
> (`measurements/README.md`). The fix is a new EIF built by `build-enclave-eif.sh` from a
> pushed commit, not pinning `.10`.
>
> Until 2026-09-23 this banner named `oracle-enclave-exec-2026-06-15.9` (PCR0 `842f4f53…`,
> commit `e38c9d6`) as live and told readers to pin it, and the verifier did. `.9` added the
> public `GET /oracle/public-key` route and the fix that makes attestation-gated
> `nsm-attest kms-decrypt` succeed in-TEE (see "KMS in-TEE" below). Its commit is no more
> reachable than `.10`'s.
>
> **KMS in-TEE (2026-06-15).** The attestation-gated KMS decrypt that materializes
> the oracle X25519 key in-TEE was silently failing: `nsm-attest` parsed the KMS
> `CiphertextForRecipient` CMS EnvelopedData with Go `encoding/asn1` (DER-only),
> but AWS KMS returns it as **indefinite-length BER** with a **segmented `[0]`
> OCTET STRING** body. Fixed in `deploy/nitro/nsm-attest/cms.go` (`berToDER` +
> `concatOctetSegments`). The oracle confidential key is now KMS-materialized
> in-TEE — no host-resident plaintext; the host holds only the enclave-decrypt-only
> ciphertext at `/var/lib/morpheus/oracle-key-kms.b64`.
>
> **Rust rewrite (since 2026-08).** The banner above, the PCR table in §1 and the
> reproducible-build steps describe the Node/Go image of that release. The frontier
> is now Rust only (`Dockerfile.enclave`: two Rust binaries, `nitro_init` as PID 1),
> and custody runs in its own enclave (`Dockerfile.signer`: three Rust binaries, the
> same supervisor, `build-custody-eif.sh`). The _procedure_ in this document is
> unchanged — check out the release you are verifying, build it with
> `--verify-reproducible`, and compare against the manifest that build wrote under
> `deploy/nitro/measurements/`. The PCRs recorded here will not match a build from
> `main`, and are not supposed to.

Release **`oracle-enclave-testnet-2026-06-14.1`** — the prior merged compute+sign
enclave (signer cutover 2026-06-14, now superseded by the exec release above).

This release is the **merged compute+sign Nitro Enclave** for the Morpheus
Oracle: the worker compute (price feeds, HTTP/JSON oracle lanes, VRF) and the
secp256r1 / secp256k1 signers run inside **one** AWS Nitro Enclave, so a result
is computed **and** signed within a single measured boundary — the host never
sees or substitutes the data between compute and signature. Because we run a
single node (not a decentralized quorum), the TEE _is_ the trust root: the
enclave attests to exactly which code is running, and consumers verify that
attestation before trusting a signed result.

The enclave reaches its price/RPC providers over an **allow-listed host egress
proxy** (`deploy/nitro/vsock-proxy.allowlist.yaml`): it has no NIC, so all
outbound traffic is end-to-end TLS to the real provider tunnelled over vsock; the
host forwards opaque ciphertext and cannot MITM. Signing keys + network + the
worker config are injected at runtime via `POST /provision` (the enclave boots
with only the baked image ENV); the **same reproducible EIF serves testnet or
mainnet** depending on the provisioned network, so its PCRs are network-agnostic.

This document tells you how to independently verify, end to end, that the code
running in the enclave is the code in this repository — with no need to trust
the operator.

---

## 1. What is measured

`nitro-cli build-enclave` derives three Platform Configuration Registers from the
enclave image:

| PCR  | Covers                                                   | Value (this release)                                                                               |
| ---- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| PCR0 | The whole enclave image (kernel + ramdisk + application) | `4a76e94891b5a698b2eba9c03fbecbeb37e195eb7963d4841feef68070c1a56ad42c60fd558613c0b40292ee44777194` |
| PCR1 | Linux kernel + boot ramdisk (stable across app changes)  | `4b4d5b3661b3efc12920900c80e126e4ce783c522de6c02a2a5bf7af3a2b9327b86776f188e4be1c1c404a129dbda493` |
| PCR2 | The application filesystem                               | `224c4d8ac2cde303f919b7165efef6c0932b042f1e50d95b3053a5ed41f67eef2943333baa0bd6de9ed3f3eaba81e3df` |

- **Hash algorithm:** SHA384 (48 bytes / 96 hex chars each)
- **Source commit:** `9ee3e2d089da64b494d8fd5da666b50207edaf6c`
- **Docker image id:** `sha256:cac832b964af48b92b4691265703e0101c8502feb74eb317d97f8ece8aae1f85`

The authoritative copy of these values is committed at
`deploy/nitro/measurements/oracle-enclave-testnet-2026-06-14.1.json` and served
live at `GET /api/attestation/measurements`. NOTE (2026-06-15): the **live mainnet
enclave now reports the EXEC PCR0 `49a14225…`** (see the superseded banner at the
top); the `4a76e948…` value in this table is the prior signer release and is kept
for historical verification of that build only.

> **Note on the `.eif` file hash.** `nitro-cli` stamps a build timestamp into the
> EIF _file_ metadata, so the **file sha256 is not stable** between builds even
> when the measured filesystem is identical. **Do not** verify by EIF file hash —
> verify by **PCR**. The PCRs are derived only from the flattened filesystem and
> are reproducible (see §2). The `eif_sha256` in the manifest identifies the one
> specific artifact this operator built, for download-integrity only.

---

## 2. Verification path A — reproducible rebuild (strongest)

The enclave image is **reproducible by construction**: a third party who rebuilds
it from this source gets **byte-identical PCRs**. This is the strongest guarantee
— it ties the published measurements to auditable source with no trust in the
operator at all.

Requirements: a Linux host with Docker and `aws-nitro-cli` installed (an
EC2 instance type that supports Nitro Enclaves, or any host with the nitro-cli
package; the measurement step does not need the enclave to actually run).

```bash
git clone https://github.com/r3e-network/neo-os-services
cd neo-morpheus-oracle
git checkout 9ee3e2d089da64b494d8fd5da666b50207edaf6c   # or the release tag

# Build twice from scratch and assert identical PCRs (the built-in gate):
SIGNER_SERVICE_URL=<manifest-custody-url> \
SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID=<manifest-raw-verifier-key-id> \
SIGNER_ROLE_UPDATER_KEY_ID=<manifest-raw-updater-key-id> \
SIGNER_ROLE_RELAYER_KEY_ID=<manifest-raw-relayer-key-id> \
SIGNER_ROLE_WORKER_KEY_ID=<manifest-raw-worker-key-id> \
SIGNER_ROLE_NEOX_UPDATER_KEY_ID=<manifest-neox-updater-key-id> \
SIGNER_ROLE_NEOX_VERIFIER_KEY_ID=<manifest-neox-verifier-key-id> \
  bash deploy/nitro/build-enclave-eif.sh --verify-reproducible
```

Expected output ends with:

```
    build #1 PCRs: 4a76e948…|4b4d5b36…|224c4d8a…
    build #2 PCRs: 4a76e948…|4b4d5b36…|224c4d8a…
    OK: identical PCR0/PCR1/PCR2 across two from-scratch builds -> reproducible enclave
        (bases are digest-pinned, so this covers every layer that varies)
```

Confirm those PCRs equal the table in §1 — they will, at the commit this section
checks out. Do not skip that `git checkout`: the frontier image has been Rust-only
since Phase 10/11 (two Rust binaries with `nitro_init` as PID 1, no Node runtime
and no Go helper), so building from `main` measures a different image and yields
different PCRs by design. Compare against the manifest your own build wrote, not
this table.

**Why it is reproducible (this release):** base images are digest-pinned
(`@sha256`), Rust dependencies resolve from committed `Cargo.lock` with
`--locked`, apt versions are pinned, and build-time cache/log/mtime sources that
would otherwise flip a layer (Cargo build outputs, apt/dpkg logs, and rootfs
file mtimes) are normalized or excluded in `Dockerfile.enclave`. The NSM path is
Rust and talks to `/dev/nsm` directly; neither Node/npm nor a Go helper is part
of the measured image graph.

**Why the current Rust image is reproducible:** both stages pull a digest-pinned
base, `cargo build --locked` resolves against the committed `Cargo.lock` and the
vendored Boa patches under `vendor/`, apt packages are pinned to exact bookworm
versions with their logs and caches deleted in the same layer, and
`SOURCE_DATE_EPOCH` plus a whole-rootfs mtime pass fixes every final mtime. The
measured stage carries only the Rust binaries and those pinned distro packages
(`socat`, `iproute2`, and for the custody image `libcap2-bin`) — no Node runtime,
no Go binary, and no entrypoint script for a host to swap.

---

## 3. Verification path B — live attestation (proves what is _running_)

This proves the enclave **actually running in production** is this exact build —
not just that the build is reproducible.

```bash
# 1. Ask the live enclave for a fresh attestation document (bind it to a nonce
#    you choose so the response cannot be replayed):
curl -s "https://runtime.meshmini.app/mainnet/attestation?nonce=$(openssl rand -hex 32)" | tee att.json
```

The endpoint returns the enclave's NSM attestation document
(`attestation_document`, COSE_Sign1, base64). `POST` that JSON to
`/api/attestation/verify` for the server-side result, including the
`measurement_verdict` described in `measurements/README.md`. To verify it
**yourself** rather than trusting the server:

1. Decode the COSE_Sign1 attestation document.
2. Verify its certificate chain terminates at the **AWS Nitro Enclaves Root G1**
   (attached: `aws-nitro-root-g1.pem`, see §5 for its fingerprint) using ES384.
3. Check the document's `pcrs` map equals PCR0/1/2 in §1.
4. Check the document's `nonce` equals the nonce you sent and `timestamp` is
   fresh.
5. Check the signed `public_key` / `user_data` binds the result-signing key the
   oracle uses on-chain.

A reference implementation of exactly this check (CBOR + COSE_Sign1 + X.509 chain
to the pinned root + PCR + nonce binding, zero external deps) lives at
`apps/web/lib/nitro-attestation.ts`, with adversarial tests in
`apps/web/lib/nitro-attestation.test.ts`.

---

## 4. Verification path C — measure a built EIF

If you have built (or obtained) the `.eif`, measure it directly without running
it:

```bash
nitro-cli describe-eif --eif-path morpheus-oracle.eif
```

Compare the `Measurements.PCR0/1/2` to §1. The attached
`describe-eif.oracle-enclave-testnet-2026-06-14.1.json` is this operator's own
`describe-eif` output for cross-reference (its `Metadata.BuildTime` is the
non-measured field that makes the file hash vary — the PCRs are what match).

---

## 5. The AWS root of trust

The whole attestation chain (path B) anchors to the AWS Nitro Enclaves PKI root,
included here so you pin the same one we do:

- File: `aws-nitro-root-g1.pem`
- **Certificate (DER) SHA-256:** `641a0321a3e244efe456463195d606317ed7cdcc3c1756e09893f3c68f79bb5b`
- Subject/Issuer: `CN=aws.nitro-enclaves, OU=AWS, O=Amazon, C=US` (self-signed)
- Validity: 2019-10-28 … 2049-10-28

This is the published AWS Nitro Enclaves Root G1. Confirm the DER SHA-256 above
matches AWS's documented value before trusting it.

---

## 6. Release assets

| Asset                                                   | What it is                                                                                                           |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `oracle-enclave-testnet-2026-06-14.1.measurements.json` | The canonical PCR manifest (source of truth for §1).                                                                 |
| `describe-eif.oracle-enclave-testnet-2026-06-14.1.json` | `nitro-cli describe-eif` of the operator's build (§4).                                                               |
| `aws-nitro-root-g1.pem`                                 | AWS Nitro Enclaves Root G1 (§5).                                                                                     |
| `nsm-attest-src/`                                       | Source of the in-enclave NSM attestation helper (`main.go` + pinned `go.mod`/`go.sum`); reproduced inside the image. |
| `SHA256SUMS`                                            | sha256 of every asset above.                                                                                         |
| `VERIFY-ATTESTATION.md`                                 | This document.                                                                                                       |

**The 295 MB `.eif` binary is not attached.** It is _reproducible from source_
(§2) — rebuilding the tagged commit yields the identical PCRs — and the build
host is access-restricted (no registry/object-store egress), so publishing the
binary adds download convenience but no verification power over the reproducible
build. If you need the prebuilt EIF, build it with §2 (you will get the exact
same measurements) or request it from the operator.

---

## 7. Status

- Reproducible build + measurements: the recipe is reproducible, but **no committed
  release is independently verifiable** — none of the eight manifests names a commit a
  branch reaches (2026-09-23; see the banner at the top).
- **Deployed live on Neo N3 mainnet (2026-06-14):** the merged compute+sign
  enclave replaced the signer-only enclave; the relayer computes+signs
  fulfilments via the enclave (`MORPHEUS_RELAYER_ENCLAVE_FULFILL`) and the
  feed-pusher computes+signs Neo N3 feed updates via the enclave
  (`MORPHEUS_FEED_PUSHER_ENCLAVE_SIGN`). The live enclave's attestation reports
  PCR0 `4a76e948…` (matches §1).
- Enclave golden-vector tests (digest/envelope/signature byte-exactness):
  `deploy/nitro/enclave-server.test.mjs`; egress allow-list tests:
  `deploy/nitro/host-egress-proxy.test.mjs`.
- **Same EIF, both networks:** the image bakes `MORPHEUS_NETWORK=testnet` as a
  default, but the runtime network + keys are injected via `/provision`, so this
  one reproducible EIF (PCRs above) is what runs on mainnet too.
- **Host-tier (not yet in-enclave):** the arbitrary-URL fetch lane (by design —
  cannot be egress-allow-listed) and the Neo X (EVM) feed-pusher path (signs
  locally with secp256k1). These remain on the host and are not enclave-attested.
