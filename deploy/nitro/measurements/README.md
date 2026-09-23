# Enclave measurements (PCR manifests)

Each `<release>.json` here records the PCR0/1/2 measurements of one Morpheus
Oracle enclave EIF release, as `build-enclave-eif.sh` measured them. The
attestation verifier accepts a live attestation document only when its PCRs
equal the **pin**: for each network, the newest release whose `git_commit` the
published history reaches, so that anybody can rebuild the image and re-derive
the PCRs. Matching a manifest nobody can rebuild proves only what the build box
saw.

> **Running on mainnet: `oracle-enclave-exec-2026-06-15.10`, and it cannot be rebuilt.**
> On 2026-09-23 the public runtime endpoint
> (`https://runtime.meshmini.app/mainnet/attestation?nonce=…`) returned a document that
> chains to the AWS Nitro root and carries the PCR0/1/2 of
> `oracle-enclave-exec-2026-06-15.10.json` (PCR0 `39fad73b…`, `git_commit` `1218f7c`),
> not those of `.9`. The recorded document is
> `apps/web/lib/attestation/recorded-mainnet-attestation-2026-09-23.json`.
>
> No fetched branch of this repository reaches `1218f7c`, or the `git_commit` of any of
> the other seven manifests here; none of the eight commit objects exists in a full clone
> fetched that day. Nobody can check out the tree any of them measures. So the verifier
> pins nothing (`REPRODUCIBLE_NITRO_RELEASES` in `apps/web/lib/nitro-measurements.ts` is
> empty) and reports the running enclave as `measured-but-unreproducible`.
>
> Do not list `.10` as reproducible to make it pass. The 2026-09-23 audit found that the
> `/sign/payload` lane of that build signs caller-supplied bytes. The way out is a new EIF
> built by `build-enclave-eif.sh` from a pushed commit, deployed in its place.

## How a manifest is produced

`deploy/nitro/build-enclave-eif.sh` (run on the Nitro box) is the only writer of
morpheus-oracle manifests. It builds the merged enclave image
(`Dockerfile.enclave`), runs `nitro-cli build-enclave`, captures its
`Measurements` JSON, and writes `deploy/nitro/measurements/<release>.json`. The
script **fails if any PCR is empty** so an empty/garbage manifest can never be
committed. Before building it also refuses, with exit 2, a working tree with
uncommitted changes and a commit that no remote branch reaches: the manifest's
`git_commit` has to be a tree somebody else can check out. Do not write or edit
a manifest by hand.

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
git add deploy/nitro/measurements/oracle-2026-06-14.json   # review the PCRs
# in the same commit, add 'oracle-2026-06-14' to REPRODUCIBLE_NITRO_RELEASES in
# apps/web/lib/nitro-measurements.ts; the gate refuses a reachable manifest it leaves out
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
can rebuild the EIF off the recorded `git_commit` and confirm the same PCRs —
provided they can check that commit out. For the eight manifests committed here
they cannot (see the banner above): the recipe is reproducible, those releases
are not. That is why the verifier pins only a release whose `git_commit` the
published history reaches.

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
  bash deploy/nitro/build-enclave-eif.sh --no-eif
```

(`--no-eif` skips `nitro-cli`, which is box-only. The reproducibility rebuild is
now the **default**: the script rebuilds the docker image from scratch —
`--no-cache`, so the Rust stage compiles twice — and compares the PCRs, which is
the authoritative check; with `--no-eif` it falls back to comparing image IDs.
Cached layers would make the comparison vacuous, since BuildKit keys its cache
on content rather than on the image tag. `--verify-reproducible` is still
accepted and now a no-op. `--allow-unverified` skips the rebuild and stamps
`reproducible_verified: false` into the manifest, which the gate below refuses —
it is for local iteration, not for a release.)

## Manifest schema

See `manifest.schema.json` (JSON Schema, draft 2020-12) for the authoritative
shape and `example.json` for a filled-in (illustrative, NON-REAL) example.

| field                   | type                      | meaning                                                             |
| ----------------------- | ------------------------- | ------------------------------------------------------------------- |
| `release`               | string                    | release id, e.g. `oracle-2026-06-14`                                |
| `app_id`                | string                    | `morpheus-oracle` \| `morpheus-custody`                             |
| `network`               | string                    | `testnet` \| `mainnet`                                              |
| `git_commit`            | string                    | full commit SHA the EIF was built from                              |
| `image_id`              | string \| null            | docker image id (`sha256:...`) the EIF was built from               |
| `eif_sha256`            | string \| null            | sha256 of the `.eif` file                                           |
| `hash_algorithm`        | string                    | PCR hash algorithm, always `SHA384` for Nitro                       |
| `pcr0`                  | string (hex 96)           | enclave image measurement (kernel + app)                            |
| `pcr1`                  | string (hex 96)           | Linux kernel + bootstrap measurement                                |
| `pcr2`                  | string (hex 96)           | application measurement                                             |
| `pcr8`                  | string (hex 96), optional | signing-cert measurement (only if the EIF is signed)                |
| `built_at`              | string                    | ISO-8601 UTC build timestamp                                        |
| `superseded_by`         | string, optional          | release id that retired this one                                    |
| `custody_boundary`      | object, optional          | oracle releases: the custody URL + six role key ids baked into PCR0 |
| `vault_profile`         | object, optional          | custody releases: the measured vault profile identity               |
| `reproducible_verified` | boolean, optional         | whether the PCRs were re-derived from a second from-scratch build   |

PCR values are SHA384 → 48 bytes → 96 lowercase hex characters.

`reproducible_verified` is **required** on every manifest built on or after the
cutover in `scripts/check-nitro-measurements.mjs`. The nine manifests that
predate it were built when the reproducibility rebuild was opt-in and nobody
passed the flag, so they carry no claim either way — which is exactly what they
are entitled to claim.

## The gate

`npm run check:nitro-measurements` (CI job `measurements`) refuses a tree where:

- a manifest does not validate against `manifest.schema.json` — two manifests
  here carried `"hash_algorithm": "Sha384 { ... }"`, nitro-cli's Rust `Debug`
  rendering, and a third carried an undeclared `superseded_by`, for three months;
- a manifest's `release` disagrees with its filename, or any PCR is all-zero
  (the value a **debug-mode** enclave reports, which makes every KMS condition
  and every verifier comparison vacuous);
- a post-cutover manifest does not record `reproducible_verified: true`;
- the KMS key policy committed under `../kms/` pins an
  `kms:RecipientAttestation:ImageSha384` that is not the `pcr0` of the manifest
  it claims to pin;
- an enclave in `../kms/attestation-pins.json`'s `required_app_ids` has neither a
  published pin nor a dated, owned `unpublished` record — or has a record whose
  `required_by` has passed;
- anything under `deploy/` or `scripts/` launches an enclave with
  `--debug-mode` or `--attach-console`;
- a pull request changes `Dockerfile.enclave`, `Dockerfile.signer`, `Cargo.lock`
  or `vendor/**` without adding a manifest whose `git_commit` is reachable;
- `REPRODUCIBLE_NITRO_RELEASES` in `apps/web/lib/nitro-measurements.ts`, the
  list the verifier derives its pin from, is not a literal list the gate can
  read, names a release with no committed manifest here, names a non-oracle or
  unreachable one, or leaves out a morpheus-oracle manifest whose `git_commit`
  HEAD descends from. It needs the full history to decide that, and fails in a
  shallow clone or outside a git checkout.

What it cannot do is build an EIF: a GitHub runner has no `nitro-cli` and no
Nitro hypervisor. Re-deriving a PCR set still happens on the box, which is why
the build scripts now do it by default.

## The verifier's verdict

`POST /api/attestation/verify` (and the `/verifier` page) reports, for a document
whose signature and AWS certificate chain verify, one of:

- `reproducible-match`: PCR0/1/2 equal the pin of their network, the newest
  release in `REPRODUCIBLE_NITRO_RELEASES` (release numbers compare numerically,
  so `.10` is newer than `.9`; a `superseded_by` release is never pinned);
- `measured-but-unreproducible`: they equal a committed manifest whose
  `git_commit` the published history does not reach — today, every one of the
  eight;
- `mismatch`: anything else, including a reproducible release that is not the
  pin and any document that does not verify.

Only a `reproducible-match` can make `full_attestation_ok` true.

## Rotation

A new EIF release = a new manifest file (do not edit an old one in place).
The verifier's pin moves by an explicit, reviewed code change — never
fetched/trusted at runtime: the manifest and its entry in
`REPRODUCIBLE_NITRO_RELEASES` land in the same commit, and the gate refuses one
without the other. The verifier deployed from that commit accepts only the new
release on its network, so roll the enclave before deploying the verifier.

Publish before you activate. The order and the reason are in `../kms/README.md`:
a client that can see the new manifest and the new key policy land before the
enclave rolls can tell an upgrade from a key substitution; a client that only
sees the roll cannot.
