#!/usr/bin/env bash
# Build the Morpheus Oracle enclave image (EIF) — the Rust-only frontier — AND
# capture its measurements (PCR0/1/2) into a committed, versioned manifest so the
# attestation verifier has a pinned source of truth.
#
# Derived from build-nitro-signer-eif.sh, with three additions required by the
# design (§4):
#   1. Uses Dockerfile.enclave (the enclave runtime image), not Dockerfile.signer.
#   2. Captures `nitro-cli build-enclave` Measurements JSON into
#      deploy/nitro/measurements/<release>.json and FAILS if PCRs are empty.
#   3. Optional --verify-reproducible: rebuilds the docker image FROM SCRATCH and
#      asserts identical PCRs (the reproducibility gate; PCRs are meaningless if
#      the image is not reproducible).
#
# Env / flags:
#   MORPHEUS_NITRO_IMAGE   docker tag for the enclave image (default morpheus-oracle-enclave:latest)
#   MORPHEUS_NITRO_EIF     output .eif path (default /opt/morpheus/nitro/morpheus-oracle.eif)
#   NITRO_CLI_ARTIFACTS    nitro-cli artifacts dir (default /opt/morpheus/nitro/artifacts)
#   NITRO_CLI_BLOBS        nitro-cli blobs dir (default /usr/share/nitro_enclaves/blobs)
#   MORPHEUS_RELEASE       release id for the manifest (default oracle-<UTC date>)
#   MORPHEUS_NETWORK       network label for the manifest (default testnet)
#   SIGNER_SERVICE_URL and SIGNER_ROLE_{ORACLE_VERIFIER,UPDATER,RELAYER,WORKER,
#                          NEOX_UPDATER,NEOX_VERIFIER}_KEY_ID are immutable
#                          custody trust anchors baked into PCR0
#   --verify-reproducible  accepted for existing runbooks; now the default.
#   --allow-unverified     SKIP the reproducibility rebuild. The manifest is then
#                          stamped reproducible_verified:false, which
#                          scripts/check-nitro-measurements.mjs refuses to accept
#                          into the tree — so this is for local iteration, never
#                          for a release whose PCR0 anybody has to trust.
#   --no-eif               build (and optionally verify) the docker image only;
#                          skip nitro-cli build-enclave (for boxes without it)
#
# A manifest is written only for a clean checkout of a commit some remote
# branch reaches (see the check below); anything else exits 2 before building.
#
# The reproducibility rebuild runs by DEFAULT. A PCR0 that was never re-derived
# from an independent build is a number only this machine can produce, and the
# KMS RecipientAttestation condition and the remote verifier are both built on
# it. Costs a second full build (the Rust stage compiles twice) — that is the
# check.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
image="${MORPHEUS_NITRO_IMAGE:-morpheus-oracle-enclave:latest}"
output="${MORPHEUS_NITRO_EIF:-/opt/morpheus/nitro/morpheus-oracle.eif}"
artifacts="${NITRO_CLI_ARTIFACTS:-/opt/morpheus/nitro/artifacts}"
blobs="${NITRO_CLI_BLOBS:-/usr/share/nitro_enclaves/blobs}"
network="${MORPHEUS_NETWORK:-testnet}"
signer_service_url="${SIGNER_SERVICE_URL:-}"
signer_role_oracle_verifier_key_id="${SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID:-}"
signer_role_updater_key_id="${SIGNER_ROLE_UPDATER_KEY_ID:-}"
signer_role_relayer_key_id="${SIGNER_ROLE_RELAYER_KEY_ID:-}"
signer_role_worker_key_id="${SIGNER_ROLE_WORKER_KEY_ID:-}"
signer_role_neox_updater_key_id="${SIGNER_ROLE_NEOX_UPDATER_KEY_ID:-}"
signer_role_neox_verifier_key_id="${SIGNER_ROLE_NEOX_VERIFIER_KEY_ID:-}"
release="${MORPHEUS_RELEASE:-oracle-$(date -u +%Y-%m-%d)}"
dockerfile="$repo_root/deploy/nitro/Dockerfile.enclave"
measurements_dir="$repo_root/deploy/nitro/measurements"
manifest="$measurements_dir/${release}.json"

for required_value in \
  "$signer_service_url" \
  "$signer_role_oracle_verifier_key_id" \
  "$signer_role_updater_key_id" \
  "$signer_role_relayer_key_id" \
  "$signer_role_worker_key_id" \
  "$signer_role_neox_updater_key_id" \
  "$signer_role_neox_verifier_key_id"; do
  if [ -z "$required_value" ]; then
    echo "ERROR: signer service URL and all six SIGNER_ROLE_*_KEY_ID values are required build-time trust anchors" >&2
    exit 2
  fi
done

if [ "$signer_role_neox_updater_key_id" = "$signer_role_neox_verifier_key_id" ]; then
  echo "ERROR: SIGNER_ROLE_NEOX_UPDATER_KEY_ID and SIGNER_ROLE_NEOX_VERIFIER_KEY_ID must be distinct custody roles" >&2
  exit 2
fi

# Reproducibility verification is the default. --verify-reproducible is kept as
# an accepted no-op so existing runbooks and systemd wrappers keep working.
verify_reproducible=1
build_eif=1
for arg in "$@"; do
  case "$arg" in
    --verify-reproducible) verify_reproducible=1 ;;
    --allow-unverified) verify_reproducible=0 ;;
    --no-eif) build_eif=0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

git_commit="$(git -C "$repo_root" rev-parse HEAD 2>/dev/null || echo unknown)"

# This script is the only writer of morpheus-oracle manifests, and a manifest is
# only as checkable as its git_commit. The eight written before this check name
# commits no branch or tag reaches, so nobody can rebuild them and the verifier
# pins none of them. Refuse, before spending the build, to measure a tree that is
# not a published commit. --no-eif writes no manifest and is not refused.
if [ "$build_eif" -eq 1 ]; then
  if [ "$git_commit" = "unknown" ]; then
    echo "ERROR: $repo_root is not a git checkout, so the manifest could name no commit" >&2
    exit 2
  fi
  if [ -n "$(git -C "$repo_root" status --porcelain --untracked-files=normal)" ]; then
    echo "ERROR: the working tree has uncommitted changes, so git_commit $git_commit does not" >&2
    echo "       describe what would be measured. Commit and push them first." >&2
    exit 2
  fi
  if [ -z "$(git -C "$repo_root" for-each-ref --contains "$git_commit" --format='%(refname)' refs/remotes)" ]; then
    echo "ERROR: no remote branch reaches git_commit $git_commit. Push it and fetch first:" >&2
    echo "       a manifest naming a commit nobody else can check out measures a tree" >&2
    echo "       nobody else can rebuild." >&2
    exit 2
  fi
fi

# Extract a Measurements field (PCR0/PCR1/PCR2/HashAlgorithm) from a captured
# `nitro-cli build-enclave` JSON blob. jq is already a Nitro host prerequisite;
# the Rust production build path has no Node dependency.
extract_measurement() { # $1=json blob  $2=field name
  printf '%s' "$1" | jq -er --arg field "$2" '.Measurements[$field] // empty' 2>/dev/null || true
}

echo "==> building enclave image $image from $dockerfile"
build_args=(
  --build-arg "MORPHEUS_NETWORK=$network"
  --build-arg "SIGNER_SERVICE_URL=$signer_service_url"
  --build-arg "SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID=$signer_role_oracle_verifier_key_id"
  --build-arg "SIGNER_ROLE_UPDATER_KEY_ID=$signer_role_updater_key_id"
  --build-arg "SIGNER_ROLE_RELAYER_KEY_ID=$signer_role_relayer_key_id"
  --build-arg "SIGNER_ROLE_WORKER_KEY_ID=$signer_role_worker_key_id"
  --build-arg "SIGNER_ROLE_NEOX_UPDATER_KEY_ID=$signer_role_neox_updater_key_id"
  --build-arg "SIGNER_ROLE_NEOX_VERIFIER_KEY_ID=$signer_role_neox_verifier_key_id"
)
# SOURCE_DATE_EPOCH is also set in the Dockerfile; pass it through for any
# builder that honors it at the layer level.
DOCKER_BUILDKIT=1 SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-1749859200}" \
  docker build "${build_args[@]}" -f "$dockerfile" -t "$image" "$repo_root"

image_id_1="$(docker image inspect --format '{{.Id}}' "$image")"
echo "==> image id: $image_id_1"

if [ "$verify_reproducible" -eq 1 ]; then
  echo "==> reproducibility check: rebuilding the whole image from scratch (--no-cache)"
  image2="${image%:*}:repro-check"
  # --no-cache is the entire point of this branch. BuildKit's layer cache is
  # keyed on the parent chain + instruction + context checksum, NOT on the image
  # tag, and it is shared across the daemon — so a second plain `docker build`
  # of the same context replays build #1's layers byte-for-byte and nothing below
  # can fail. Base images no longer add drift of their own: both stages of
  # Dockerfile.enclave pull a resolved @sha256, so --no-cache covers everything
  # that varies and --pull would add nothing.
  DOCKER_BUILDKIT=1 SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-1749859200}" \
    docker build --no-cache "${build_args[@]}" -f "$dockerfile" -t "$image2" "$repo_root"
  image_id_2="$(docker image inspect --format '{{.Id}}' "$image2")"
  echo "    build #1 image id: $image_id_1"
  echo "    build #2 image id: $image_id_2"
  if [ "$build_eif" -eq 1 ]; then
    # AUTHORITATIVE GATE: compare the nitro-cli PCRs of the two from-scratch
    # builds. Docker IMAGE IDs are NOT a valid reproducibility signal — the image
    # config carries a build-time `created`/`history` timestamp, so two identical
    # rootfs builds can yield different image IDs. PCR0/1/2 are derived from the
    # flattened filesystem only, so equal PCRs ⇔ reproducible enclave.
    mkdir -p "$artifacts"
    export NITRO_CLI_ARTIFACTS="$artifacts" NITRO_CLI_BLOBS="$blobs"
    out_a="$(nitro-cli build-enclave --docker-uri "$image"  --output-file /tmp/.repro-a.eif)"
    out_b="$(nitro-cli build-enclave --docker-uri "$image2" --output-file /tmp/.repro-b.eif)"
    rm -f /tmp/.repro-a.eif /tmp/.repro-b.eif
    pcrs_a="$(extract_measurement "$out_a" PCR0)|$(extract_measurement "$out_a" PCR1)|$(extract_measurement "$out_a" PCR2)"
    pcrs_b="$(extract_measurement "$out_b" PCR0)|$(extract_measurement "$out_b" PCR1)|$(extract_measurement "$out_b" PCR2)"
    echo "    build #1 PCRs: $pcrs_a"
    echo "    build #2 PCRs: $pcrs_b"
    if [ "$pcrs_a" != "$pcrs_b" ] || [ "$pcrs_a" = "||" ]; then
      echo "ERROR: enclave is NOT reproducible — PCRs differ across two from-scratch builds." >&2
      echo "       A measurements manifest from a non-reproducible build cannot be independently verified." >&2
      docker image rm "$image2" >/dev/null 2>&1 || true
      exit 1
    fi
    echo "    OK: identical PCR0/PCR1/PCR2 across two from-scratch builds -> reproducible enclave"
    echo "        (bases are digest-pinned, so this covers every layer that varies)"
  else
    # --no-eif: nitro-cli is unavailable/skipped, so fall back to the weaker
    # image-ID heuristic (which can false-negative on config timestamps).
    if [ "$image_id_1" != "$image_id_2" ]; then
      echo "WARN: image IDs differ; cannot confirm reproducibility without nitro-cli." >&2
      echo "      Re-run without --no-eif to compare PCRs (the authoritative check)." >&2
    else
      echo "    OK: identical image IDs (re-run without --no-eif for the PCR-level check)"
    fi
  fi
  docker image rm "$image2" >/dev/null 2>&1 || true
fi

if [ "$build_eif" -eq 0 ]; then
  echo "==> --no-eif: skipping nitro-cli build-enclave + manifest capture"
  exit 0
fi

mkdir -p "$(dirname "$output")" "$artifacts" "$measurements_dir"
export NITRO_CLI_ARTIFACTS="$artifacts"
export NITRO_CLI_BLOBS="$blobs"

echo "==> nitro-cli build-enclave -> $output"
# build-enclave prints a JSON object with a "Measurements" field
# ({HashAlgorithm, PCR0, PCR1, PCR2}). Capture stdout to derive the manifest.
build_output="$(nitro-cli build-enclave --docker-uri "$image" --output-file "$output")"
echo "$build_output"

# Extract PCRs from the build-enclave JSON (same helper as the repro gate above).
pcr0="$(extract_measurement "$build_output" PCR0)"
pcr1="$(extract_measurement "$build_output" PCR1)"
pcr2="$(extract_measurement "$build_output" PCR2)"
hash_algo="$(extract_measurement "$build_output" HashAlgorithm)"
hash_algo="${hash_algo:-SHA384}"
# nitro-cli renders the algorithm with Rust's Debug formatter ("Sha384 { ... }")
# on some versions. Two committed manifests carried that string and therefore
# failed manifest.schema.json's `const: SHA384`; normalise it at the source.
case "$(printf '%s' "$hash_algo" | tr 'A-Z' 'a-z')" in
  *sha384*|*sha-384*) hash_algo="SHA384" ;;
esac

# FAIL if PCRs are empty (a manifest with empty PCRs is worse than none — it
# would make the verifier accept anything or fail confusingly).
if [ -z "$pcr0" ] || [ -z "$pcr1" ] || [ -z "$pcr2" ]; then
  echo "ERROR: nitro-cli build-enclave returned empty PCR(s)" >&2
  echo "       PCR0='$pcr0' PCR1='$pcr1' PCR2='$pcr2'" >&2
  echo "       refusing to write an empty measurements manifest." >&2
  exit 1
fi

eif_sha256=""
if [ -f "$output" ]; then
  eif_sha256="$(sha256sum "$output" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$output" 2>/dev/null | awk '{print $1}')"
fi

built_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [ "$verify_reproducible" -ne 1 ]; then
  echo "REFUSING TO CERTIFY: --allow-unverified was passed, so this PCR0 was never" >&2
  echo "         re-derived from an independent build. The manifest below is stamped" >&2
  echo "         reproducible_verified:false, which the measurement gate" >&2
  echo "         (scripts/check-nitro-measurements.mjs, CI job 'measurements') refuses" >&2
  echo "         in the tree. Committing it would make it the verifier's" >&2
  echo "         source of truth for an enclave whose measurement nobody reproduced —" >&2
  echo "         if a later build changes the PCR, the enclave is refused at boot." >&2
  echo "         Re-run without --allow-unverified before shipping this release." >&2
fi

echo "==> writing manifest $manifest"
RELEASE="$release" APP_ID="morpheus-oracle" NETWORK="$network" \
GIT_COMMIT="$git_commit" EIF_SHA256="$eif_sha256" HASH_ALGO="$hash_algo" \
PCR0="$pcr0" PCR1="$pcr1" PCR2="$pcr2" BUILT_AT="$built_at" IMAGE_ID="$image_id_1" \
REPRODUCIBLE_VERIFIED="$verify_reproducible" \
SIGNER_SERVICE_URL="$signer_service_url" \
SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID="$signer_role_oracle_verifier_key_id" \
SIGNER_ROLE_UPDATER_KEY_ID="$signer_role_updater_key_id" \
SIGNER_ROLE_RELAYER_KEY_ID="$signer_role_relayer_key_id" \
SIGNER_ROLE_WORKER_KEY_ID="$signer_role_worker_key_id" \
SIGNER_ROLE_NEOX_UPDATER_KEY_ID="$signer_role_neox_updater_key_id" \
SIGNER_ROLE_NEOX_VERIFIER_KEY_ID="$signer_role_neox_verifier_key_id" \
jq -n '
  {
    release: env.RELEASE,
    app_id: env.APP_ID,
    network: env.NETWORK,
    custody_boundary: {
      service_url: env.SIGNER_SERVICE_URL,
      oracle_verifier_key_id: env.SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID,
      updater_key_id: env.SIGNER_ROLE_UPDATER_KEY_ID,
      relayer_key_id: env.SIGNER_ROLE_RELAYER_KEY_ID,
      worker_key_id: env.SIGNER_ROLE_WORKER_KEY_ID,
      neox_updater_key_id: env.SIGNER_ROLE_NEOX_UPDATER_KEY_ID,
      neox_verifier_key_id: env.SIGNER_ROLE_NEOX_VERIFIER_KEY_ID
    },
    git_commit: env.GIT_COMMIT,
    image_id: env.IMAGE_ID,
    eif_sha256: (if env.EIF_SHA256 == "" then null else env.EIF_SHA256 end),
    hash_algorithm: (env.HASH_ALGO // "SHA384"),
    pcr0: env.PCR0,
    pcr1: env.PCR1,
    pcr2: env.PCR2,
    reproducible_verified: (env.REPRODUCIBLE_VERIFIED == "1"),
    built_at: env.BUILT_AT
  }
' >"$manifest"

echo "==> measurements captured:"
cat "$manifest"
echo
echo "==> DONE. Commit $manifest (review the PCRs) and, in the same change, list"
echo "    $release in REPRODUCIBLE_NITRO_RELEASES (apps/web/lib/nitro-measurements.ts);"
echo "    npm run check:nitro-measurements refuses a reachable manifest the pin leaves out."
