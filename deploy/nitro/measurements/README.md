# Enclave measurements (PCR manifests)

Each `<release>.json` here is the **pinned source of truth** for one Morpheus
Oracle enclave EIF release: the PCR0/1/2 measurements that the attestation
verifier compares against an enclave's live attestation document. If the live
document's PCRs do not match the committed manifest, the verifier rejects it —
that is what proves an enclave runs the genuine, reviewed oracle code.

> **Current live mainnet release: `oracle-enclave-exec-2026-06-15.9.json`** — PCR0
> `842f4f53…` (commit `e38c9d6`). Adds the public `GET /oracle/public-key` route and the
> `nsm-attest` CMS BER→DER fix that makes attestation-gated `kms-decrypt` work in-TEE, so the
> oracle X25519 key is KMS-materialized in-enclave (no host-resident plaintext). The CMK
> `EnclaveAttestedDecrypt` policy is pinned to this single PCR0.

## How a manifest is produced

`deploy/nitro/build-enclave-eif.sh` (run on the Nitro box) builds the merged
enclave image (`Dockerfile.enclave`), runs `nitro-cli build-enclave`, captures
its `Measurements` JSON, and writes `deploy/nitro/measurements/<release>.json`.
The script **fails if any PCR is empty** so an empty/garbage manifest can never
be committed.

The manifest also records the public custody boundary baked into that PCR:
service URL and all six role key ids. Independent rebuilds must supply those
exact values; none is a secret. The NeoX updater and verifier must be different
keys because transaction submission and EIP-191 proof signing are separate
authorities.

```
# on the box, from the repo root:
MORPHEUS_RELEASE=oracle-2026-06-14 MORPHEUS_NETWORK=testnet \
  SIGNER_SERVICE_URL=<custody-url> \
  SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID=<raw-verifier-key-id> \
  SIGNER_ROLE_UPDATER_KEY_ID=<raw-updater-key-id> \
  SIGNER_ROLE_RELAYER_KEY_ID=<raw-relayer-key-id> \
  SIGNER_ROLE_WORKER_KEY_ID=<raw-worker-key-id> \
  SIGNER_ROLE_NEOX_UPDATER_KEY_ID=<neox-updater-key-id> \
  SIGNER_ROLE_NEOX_VERIFIER_KEY_ID=<neox-verifier-key-id> \
  bash deploy/nitro/build-enclave-eif.sh
git add deploy/nitro/measurements/oracle-2026-06-14.json   # review the PCRs, then commit
```

## Why it is committed in-repo

Serving the manifest only from the Morpheus server the user is trying NOT to
trust is circular. Committing it makes the expected measurements **reviewable in
version control** and shippable to the client-side verifier as a static asset.
The API route (`apps/web/app/api/attestation/measurements`, Phase 2) serves this
same committed file; the offline/in-browser verifier ships its own pinned copy.

## Reproducibility — how far these PCRs actually are

PCR0/1/2 are derived deterministically from the docker image. The image is
reproducible by construction (`Dockerfile.enclave`, and `Dockerfile.signer` the
same way): both stages pull a **digest-pinned** base (`@sha256`, resolved
2026-09-02 from the Docker Hub registry API), `cargo build --locked` resolves
against the committed `Cargo.lock` and the vendored Boa patches under `vendor/`
(no network resolution, no lockfile drift), apt packages are pinned to exact
bookworm versions with their logs and caches deleted in the same layer, and
`SOURCE_DATE_EPOCH` plus a whole-rootfs mtime pass fixes every final mtime. Anyone
can rebuild the EIF off the recorded `git_commit` and confirm the same PCRs.

The operator's share of that bargain: a base digest is bumped deliberately, never
as a side effect of a dependency update, because changing one changes the
measurement. Verify locally with:

```
SIGNER_SERVICE_URL=<custody-url> \
SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID=<raw-verifier-key-id> \
SIGNER_ROLE_UPDATER_KEY_ID=<raw-updater-key-id> \
SIGNER_ROLE_RELAYER_KEY_ID=<raw-relayer-key-id> \
SIGNER_ROLE_WORKER_KEY_ID=<raw-worker-key-id> \
SIGNER_ROLE_NEOX_UPDATER_KEY_ID=<neox-updater-key-id> \
SIGNER_ROLE_NEOX_VERIFIER_KEY_ID=<neox-verifier-key-id> \
  bash deploy/nitro/build-enclave-eif.sh --verify-reproducible --no-eif
```

(`--no-eif` skips `nitro-cli`, which is box-only. `--verify-reproducible` rebuilds
the docker image from scratch — `--no-cache`, so the Rust stage compiles twice —
and compares image IDs; without `--no-eif` it compares the PCRs themselves, which
is the authoritative check. Cached layers would make the comparison vacuous, since
BuildKit keys its cache on content rather than on the image tag.)

## Manifest schema

See `manifest.schema.json` (JSON Schema, draft 2020-12) for the authoritative
shape and `example.json` for a filled-in (illustrative, NON-REAL) example.

| field            | type                      | meaning                                               |
| ---------------- | ------------------------- | ----------------------------------------------------- |
| `release`        | string                    | release id, e.g. `oracle-2026-06-14`                  |
| `app_id`         | string                    | always `morpheus-oracle`                              |
| `network`        | string                    | `testnet` \| `mainnet`                                |
| `git_commit`     | string                    | full commit SHA the EIF was built from                |
| `image_id`       | string \| null            | docker image id (`sha256:...`) the EIF was built from |
| `eif_sha256`     | string \| null            | sha256 of the `.eif` file                             |
| `hash_algorithm` | string                    | PCR hash algorithm, always `SHA384` for Nitro         |
| `pcr0`           | string (hex 96)           | enclave image measurement (kernel + app)              |
| `pcr1`           | string (hex 96)           | Linux kernel + bootstrap measurement                  |
| `pcr2`           | string (hex 96)           | application measurement                               |
| `pcr8`           | string (hex 96), optional | signing-cert measurement (only if the EIF is signed)  |
| `built_at`       | string                    | ISO-8601 UTC build timestamp                          |

PCR values are SHA384 → 48 bytes → 96 lowercase hex characters.

## Rotation

A new EIF release = a new manifest file (do not edit an old one in place).
The verifier's pinned-manifest set is updated by an explicit, reviewed code
change — never fetched/trusted at runtime.
