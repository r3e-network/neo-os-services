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

```
# on the box, from the repo root:
MORPHEUS_RELEASE=oracle-2026-06-14 MORPHEUS_NETWORK=testnet \
  bash deploy/nitro/build-enclave-eif.sh
git add deploy/nitro/measurements/oracle-2026-06-14.json   # review the PCRs, then commit
```

## Why it is committed in-repo

Serving the manifest only from the Morpheus server the user is trying NOT to
trust is circular. Committing it makes the expected measurements **reviewable in
version control** and shippable to the client-side verifier as a static asset.
The API route (`apps/web/app/api/attestation/measurements`, Phase 2) serves this
same committed file; the offline/in-browser verifier ships its own pinned copy.

## Reproducibility — why these PCRs are independently verifiable

PCR0/1/2 are derived deterministically from the docker image. The image is
reproducible by construction (`Dockerfile.enclave`): digest-pinned base images,
`npm ci` from the committed `package-lock.json`, a pinned Go module
(`nsm-attest/go.mod` + `go.sum`), and `SOURCE_DATE_EPOCH` + normalized mtimes.
Anyone can rebuild the EIF off the recorded `git_commit` and confirm the same
PCRs. Verify the docker layer is reproducible locally with:

```
bash deploy/nitro/build-enclave-eif.sh --verify-reproducible --no-eif
```

(`--no-eif` skips `nitro-cli`, which is box-only; `--verify-reproducible` builds
the docker image twice and asserts identical image IDs.)

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
