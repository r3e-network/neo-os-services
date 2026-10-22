# Combined enclave image

This additive path packages two public custody profiles and their immutable
network map with one `enclave_host` business process. `nitro_init` and the existing
socat bridges remain supervision/transport plumbing. There is no standalone
signer process or listener. The existing single-network Dockerfile and builder
retain their previous behavior.

This is packaging source, not a deployable release. Real native custody profiles,
authority provenance, a working Linux amd64 Docker/Nitro build environment, two
matching measured builds, independent review and release admission are required.
Historical signer KMS ciphertext names or an existing oracle verifier public key
are not native custody profiles and must not be converted into invented state.

## Explicit public inputs

Supply a reviewed JSON file (at most 64 KiB) and its separately reviewed SHA-256.
All fields below are required; unknown and duplicate fields are rejected:

- `schema`: `neoos/dual-image-input/v1`.
- `release`: a public release identifier.
- `source_commit`: exact 40-character source HEAD, including integrated host code.
- `networks`: exactly `mainnet` and `testnet`, each containing the fields below.

Each network has `profile_file` (exactly `mainnet.json` or `testnet.json`, beside
the input file), `profile_sha256` (hash of the exact bytes, not normalized JSON),
`workload_audience` (canonical HTTPS origin), `aws_region`,
`frontier_kms_key_arn`, `neo_n3_rpc`, `neo_x_rpc`, and `roles`.
`roles` contains exactly `ORACLE_VERIFIER`, `UPDATER`, `RELAYER`, `WORKER`,
`NEOX_UPDATER` and `NEOX_VERIFIER`: explicit, distinct public custody key IDs,
including across deployments. Role IDs are 1–128 ASCII letters, digits, underscores
or hyphens, matching native key-route validation; dots are refused. RPCs are explicit reviewed public HTTPS URLs;
userinfo, query credentials, fragments, IP literals and ambiguous paths are
refused. No DNS or RPC call is made by preparation; the reviewer must verify
endpoint ownership and network semantics. A URL spelling check cannot establish
those facts.

Each profile uses the existing `VaultProfile` schema and binds both `neo-n3` and
`neox`, in that order. IDs and any published genesis are checked against the
exact source's `config/networks` registry. The profile carries the reviewed
custody KMS ARN, root commitment/version, authority origin, snapshot bucket/prefix,
and receipt verification public keys. The two vault identities, root commitments,
authority origins, snapshot namespaces and audiences must be distinct. No root
key, snapshot body, token, AWS credential or arbitrary environment map is accepted.
No production fixture is supplied. Tests use synthetic commitments and a public
P-256 generator point; they do not create a production identity or durable state.

Each network may also declare `feed_price_plane`, exactly `twelvedata` or
`public-quorum`. An omitted field preserves the existing generated map and the
host's TwelveData default. A present empty, non-string or unknown value is
refused. For key-free prices on both networks, declare
`"feed_price_plane": "public-quorum"` in each network entry. Preparation writes
that selection as `FEED_PRICE_PLANE` in that network's measured map; the
independent release validator reconstructs and compares the same map. Global
environment values and runtime provisioning cannot supply this selection.
The default host egress allowlist includes the three fixed public-quorum hosts
on port 443, including `api.coingecko.com`; redirects and unknown destinations
remain refused. Changed context/map bytes require fresh measured release
evidence and admission. Preparation or synthetic tests do not provide either.

The generated map fixes profile paths at `/app/config/custody/{network}.json`,
data at `/var/lib/neoos-custody/{network}`, and internal transport at
`http://127.0.0.1:0/{network}`. It supplies reviewed role/RPC/KMS anchors separately
per context. Credentials are provisioned later through the existing attested
interfaces, including the distinct external `/custody/provision` namespace.
`/signer/api/v1` remains the canonical native custody API path.

## Preparation and measured build

Use physical absolute paths (input paths with symlink components are refused).
The output must be new and outside the source checkout. Parent directories must
already exist and must have no symlink or `..` components. Preparation and build
pin the parent directory before reading inputs, write through directory handles,
and publish a complete, flushed directory with an atomic no-replace rename.
Failures before publication remove only the private staging directory, so retry
is possible. A parent-directory flush failure after rename can leave a complete
pair with uncertain crash durability; inspect that pair before an explicit retry.

```sh
python3 deploy/nitro/build-dual-enclave.py prepare \
  --repo /reviewed/neo-os-services \
  --input /reviewed/public/dual-input.json \
  --input-sha256 REVIEWED_INPUT_SHA256 \
  --output /reviewed/output/dual-context
```

`prepare` requires a clean exact HEAD and exports only selected tracked Rust
source/build inputs plus the two explicitly supplied public profiles and map.
Replacement refs and legacy grafts are disabled. Archive and ancestry operations
use private Git metadata with read-only access to the source object store. Every
selected archive member must match its reviewed tree blob, with no omissions,
duplicates or archive substitutions. Local Git attributes and URL rewrites are
not inherited by those operations.
Ignored `.env` files are never read or copied. Source archive and individual
context file digests are recorded in `context-manifest.json`. This mode performs
structural checks and creates a reviewable context; it does **not** claim Rust
preparation, a built image, measured PCRs or release readiness.

```sh
python3 deploy/nitro/build-dual-enclave.py build \
  --repo /reviewed/neo-os-services \
  --input /reviewed/public/dual-input.json \
  --input-sha256 REVIEWED_INPUT_SHA256 \
  --output /reviewed/output/dual-measured-candidate
```

`build` additionally requires canonical HTTPS origin
`https://github.com/r3e-network/neo-os-services.git`, a fresh read of `main`, and
proof that the exact source is its ancestor. A local snapshot, fork or invented
tracking ref cannot certify a build. Paths to Docker, nitro-cli and Nitro blobs
can be supplied explicitly. Tools are operator-trusted prerequisites; an
arbitrary substitute executable is not an attestation verifier.

The builder uses an empty private Docker config and a fixed local Unix socket,
not ambient Docker contexts, registry credentials, proxy settings or build args.
It requires Docker Buildx and builds twice without cache for Linux amd64 using
one uniquely named docker-container builder (4 GiB memory, one CPU quota, one
BuildKit worker task). It never changes the default builder. The owned builder
uses the Docker exporter with `rewrite-timestamp=true` and the fixed
`SOURCE_DATE_EPOCH=1749859200` from its private child environment. This normalizes
exported layer timestamps in addition to the Dockerfile's filesystem pass;
it does not normalize or rewrite the resulting EIF. Both measured builds must
still agree on every PCR. No registry push or caller-supplied build argument is
enabled by this exporter selection. The owned builder
is stopped and removed on success or failure before output publication, including
when a client times out. Container/image cleanup is attempted for every owned ID;
a cleanup failure refuses publication and requires operator inspection. No shared
builder, Docker daemon or unrelated object is stopped or pruned.

Commands run in separate process groups with TERM then KILL cleanup, including
descendants. CLI SIGTERM and keyboard interruption unwind the same cleanup path. Capture is disk-backed with a 256 MiB combined-output refusal threshold;
individual process files are capped at 2 GiB, descriptors at 512, and core dumps
disabled. Wall deadlines are 3600 seconds per Docker build, 1800 per EIF conversion,
120 for other tools and 30 per cleanup action. These client limits do not establish
Linux/daemon runtime behavior: the actual owned-builder cancellation and Linux
resource limits still require verification in the authorized build environment.

Both builds compile
`deploy/nitro/dual-prepare.rs` as an isolated build-stage example against the
**same exact host library**. The helper uses fixed production boot policy,
`NetworkProfiles::from_overlay` and `custody_bootstrap::prepare`; it performs no
NSM, KMS, state creation, signing or listener startup. No host source, manifest or
lockfile edit is needed. Both profiles and the map are copied into the measured
runtime. The helper is not copied into it.

Each image's copied profile bytes, map, runtime ENV and exact Rust validation
receipt are read back without starting a container. Each EIF's PCR0/1/2 is checked
against `describe-eif`; zero, missing or mismatched PCRs fail. The two independent
builds must agree on all three PCRs. Only the first already-measured EIF is
published, with source/input/image/file/EIF digests and both measurement results.
There is no third unchecked build and no `--allow-unverified` or `--no-eif` mode.
No enclave is launched; no AWS resource or policy is changed.

`build-evidence.json` has the distinct `neoos/dual-image-build-evidence/v1` schema.
It is **not** a legacy single-network measurement manifest or an admission
receipt. Existing verifier pins, measurement gates and KMS policies are not
changed here. Admission of a dual-network release needs a separately reviewed
manifest/verifier/policy integration; do not file this evidence under an old
single-network release or silently refresh its hashes.

## Local checks

```sh
node --test deploy/nitro/dual-image.test.mjs
python3 deploy/nitro/test-dual-preparation.py
```

The ops wrapper runs hermetic orchestration/negative tests with recording tools
and the Rust preparation check. Recording controls do not prove Docker execution
or EIF reproducibility. The Python command runs just the Rust check, using an
exact HEAD archive and private target with synthetic public profiles. Cargo dependencies must be cached; it is
offline and single-job. Run it only after freezing the candidate so HEAD contains
the helper and tests. The normal ops glob includes both checks. An explicit private `CARGO_TARGET_DIR`
is reused by the wrapper; otherwise the Rust check creates a new temporary target.

Actual profile provenance, public endpoint ownership, authority deployment and
snapshot lineage, measured EIFs, release policy admission and live dual-network
readback remain separate prerequisites.

## Optional native ARM builder candidate

The default remains the reviewed Linux amd64 recipe and stock LinuxKit. An
explicit `--builder-platform linux/arm64 --cross-cache /physical/public-cache`
selects `Dockerfile.dual-enclave.cross` during `prepare` or `build`. The cache
must contain `objects/sha256/<digest>` for every entry in
`cross-inputs.lock.json`. Only those objects are read; size, SHA-256, regular-file
type and every path component are checked before context publication. No cache
configuration or credentials are copied. The lock contains the 24 exact Debian
cross-toolchain packages and Rust 1.98.0 x86 target library files validated by the
local cross-compile diagnostic. Cache acquisition is a separate public-input
step; missing objects fail without fetching or substituting versions.

The builder uses the pinned native ARM child of the same Rust 1.98 Bookworm
index, restores the verified packages and x86 target libraries offline, and sets
the x86 gcc/g++/ar toolchain explicitly. Cargo remains locked and single-job.
The build output, helper and runtime are x86_64-unknown-linux-gnu / linux/amd64.
The build-only x86 helper uses the cross sysroot under the existing emulator,
with a 30-second limit. This requires working x86 user-mode emulation on the
builder; no emulator or host configuration is installed by this recipe.
The existing runtime base, packages, policy, entrypoint and timestamp pass are
unchanged. This is an alternative compilation path, not a claim of identical
binary bytes, image digests or PCRs across builder architectures.

Independently, `build --linuxkit-mode native-arm64 --native-linuxkit
/physical/aws-v1.5.2/blobs/aarch64/linuxkit --nitro-blobs
/physical/aws-v1.5.2/blobs/x86_64` enables an explicit adapter. The adapter pins
AWS Nitro CLI v1.5.2 source commit
`1c496ed730d2dc41ec5bff6df89b4f3185e18840`: the ARM LinuxKit SHA-256 is
`426cb1685ccd35e89b49abd3eb6357494436663606254c37315a8399105ddf16`.
The five x86 kernel/init/NSM inputs are separately pinned in `dual_cross.py`.
All are verified before copying into an owned temporary bundle. Its LinuxKit
entrypoint accepts only `build`, inserts `--arch amd64`, and rejects architecture
overrides. Stock x86 nitro-cli remains the EIF creator and inspector. No
existing tool directory is rewritten, and no automatic architecture fallback
occurs. CLI version/help and adapter tests alone do not prove EIF compatibility.

Run `python3 -B deploy/nitro/dual_cross_test.py` for synthetic cache, selection,
architecture and integrity controls; the normal dual-image Node suite includes
it. Actual Docker builds and measured EIF comparisons still require reviewed
public profiles and a separately authorized trusted Linux builder. These flags
do not weaken canonical source, public-profile, cleanup or reproducibility gates.
