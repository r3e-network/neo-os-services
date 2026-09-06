#!/usr/bin/env bash
# Build the custody enclave image (EIF) AND capture its measurements
# (PCR0/1/2) into a committed, versioned manifest so the attestation verifier
# has a pinned source of truth.
#
# Mirrors build-enclave-eif.sh for the custody image: Dockerfile.signer — the
# Rust signer_service binary, zero Node — replaces Dockerfile.enclave, and the
# manifest is stamped app_id "morpheus-custody". The legacy Node signer image
# is measured by build-nitro-signer-eif.sh from Dockerfile.signer-legacy; the
# two pipelines must not be mixed, since a verifier that pins one manifest
# expects the matching enclave.
#
# Env / flags:
#   MORPHEUS_CUSTODY_IMAGE  docker tag for the enclave image (default morpheus-custody-enclave:latest)
#   MORPHEUS_CUSTODY_EIF    output .eif path (default /opt/morpheus/nitro/morpheus-custody.eif)
#   NITRO_CLI_ARTIFACTS     nitro-cli artifacts dir (default /opt/morpheus/nitro/artifacts)
#   NITRO_CLI_BLOBS         nitro-cli blobs dir (default /usr/share/nitro_enclaves/blobs)
#   MORPHEUS_RELEASE        release id for the manifest (default custody-<UTC date>)
#   MORPHEUS_NETWORK        network label for the manifest (default testnet)
#   SIGNER_SERVICE_WORKLOAD_AUDIENCE
#                           canonical origin NeoNexus/callers use for custody;
#                           defaults to http://127.0.0.1:<custody host port>
#   --verify-reproducible   rebuild the docker image FROM SCRATCH and require
#                           identical PCRs. Costs a second full build (the Rust
#                           stage compiles twice) — that is the check.
#   --no-eif                build (and optionally verify) the docker image only;
#                           skip nitro-cli build-enclave (for boxes without it)
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
image="${MORPHEUS_CUSTODY_IMAGE:-morpheus-custody-enclave:latest}"
output="${MORPHEUS_CUSTODY_EIF:-/opt/morpheus/nitro/morpheus-custody.eif}"
artifacts="${NITRO_CLI_ARTIFACTS:-/opt/morpheus/nitro/artifacts}"
blobs="${NITRO_CLI_BLOBS:-/usr/share/nitro_enclaves/blobs}"
network="${MORPHEUS_NETWORK:-testnet}"
release="${MORPHEUS_RELEASE:-custody-$(date -u +%Y-%m-%d)}"
dockerfile="$repo_root/deploy/nitro/Dockerfile.signer"
measurements_dir="$repo_root/deploy/nitro/measurements"
manifest="$measurements_dir/${release}.json"
custody_host_port="${MORPHEUS_CUSTODY_HOST_PORT:-8789}"
workload_audience="${SIGNER_SERVICE_WORKLOAD_AUDIENCE:-http://127.0.0.1:${custody_host_port}}"

verify_reproducible=0
build_eif=1
for arg in "$@"; do
  case "$arg" in
    --verify-reproducible) verify_reproducible=1 ;;
    --no-eif) build_eif=0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

git_commit="$(git -C "$repo_root" rev-parse HEAD 2>/dev/null || echo unknown)"

# Extract a Measurements field (PCR0/1/2/HashAlgorithm) from a captured
# `nitro-cli build-enclave` JSON blob with the host's jq prerequisite.
extract_measurement() { # $1=json blob  $2=field name
  printf '%s' "$1" | jq -er --arg field "$2" '.Measurements[$field] // empty' 2>/dev/null || true
}

echo "==> building custody enclave image $image from $dockerfile"
echo "==> workload audience: $workload_audience"
# SOURCE_DATE_EPOCH is also set at the layer level for any builder that honors
# it; the Rust build itself is reproducible in practice because cargo does not
# embed timestamps, but the authoritative gate below compares PCRs, not ids.
DOCKER_BUILDKIT=1 SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-1749859200}" \
  docker build \
    --build-arg "SIGNER_SERVICE_WORKLOAD_AUDIENCE=$workload_audience" \
    -f "$dockerfile" -t "$image" "$repo_root"

image_id_1="$(docker image inspect --format '{{.Id}}' "$image")"
echo "==> image id: $image_id_1"

if [ "$verify_reproducible" -eq 1 ]; then
  echo "==> reproducibility check: rebuilding the whole image from scratch (--no-cache)"
  image2="${image%:*}:repro-check"
  # --no-cache is the entire point of this branch. BuildKit's layer cache is
  # keyed on the parent chain + instruction + context checksum, NOT on the image
  # tag, and it is shared across the daemon — so a second plain `docker build`
  # of the same context replays build #1's layers byte-for-byte and the PCR
  # comparison below can only ever pass. That would certify "nitro-cli is
  # deterministic", which was never in question, instead of "this Dockerfile
  # produces the same rootfs every time", which is what the KMS policy needs.
  # Base images no longer add drift of their own: both stages of
  # Dockerfile.signer pull a resolved @sha256, so --no-cache covers everything
  # that varies and --pull would add nothing.
  DOCKER_BUILDKIT=1 SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-1749859200}" \
    docker build --no-cache \
      --build-arg "SIGNER_SERVICE_WORKLOAD_AUDIENCE=$workload_audience" \
      -f "$dockerfile" -t "$image2" "$repo_root"
  image_id_2="$(docker image inspect --format '{{.Id}}' "$image2")"
  echo "    build #1 image id: $image_id_1"
  echo "    build #2 image id: $image_id_2"
  if [ "$build_eif" -eq 1 ]; then
    # AUTHORITATIVE GATE: compare the nitro-cli PCRs of the two from-scratch
    # builds. Docker IMAGE IDs are NOT a valid reproducibility signal — the
    # image config carries a build-time `created`/`history` timestamp, so two
    # identical rootfs builds can yield different image IDs. PCR0/1/2 are
    # derived from the flattened filesystem only, so equal PCRs ⇔ reproducible
    # enclave.
    mkdir -p "$artifacts"
    export NITRO_CLI_ARTIFACTS="$artifacts" NITRO_CLI_BLOBS="$blobs"
    out_a="$(nitro-cli build-enclave --docker-uri "$image"  --output-file /tmp/.custody-repro-a.eif)"
    out_b="$(nitro-cli build-enclave --docker-uri "$image2" --output-file /tmp/.custody-repro-b.eif)"
    rm -f /tmp/.custody-repro-a.eif /tmp/.custody-repro-b.eif
    pcrs_a="$(extract_measurement "$out_a" PCR0)|$(extract_measurement "$out_a" PCR1)|$(extract_measurement "$out_a" PCR2)"
    pcrs_b="$(extract_measurement "$out_b" PCR0)|$(extract_measurement "$out_b" PCR1)|$(extract_measurement "$out_b" PCR2)"
    echo "    build #1 PCRs: $pcrs_a"
    echo "    build #2 PCRs: $pcrs_b"
    if [ "$pcrs_a" != "$pcrs_b" ] || [ "$pcrs_a" = "||" ]; then
      echo "ERROR: custody enclave is NOT reproducible — PCRs differ across two from-scratch builds." >&2
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

pcr0="$(extract_measurement "$build_output" PCR0)"
pcr1="$(extract_measurement "$build_output" PCR1)"
pcr2="$(extract_measurement "$build_output" PCR2)"
hash_algo="$(extract_measurement "$build_output" HashAlgorithm)"
hash_algo="${hash_algo:-SHA384}"

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
  echo "WARNING: --verify-reproducible was not passed, so this PCR0 was never re-derived" >&2
  echo "         from an independent build. That is the assumption the next step rests on:" >&2
  echo "         committing this manifest and pinning the same PCR0 in the custody KMS key" >&2
  echo "         policy. If the image turns out NOT to be reproducible, the next rebuild" >&2
  echo "         measures a different PCR0 and /provision can no longer decrypt the master" >&2
  echo "         key — an outage discovered while booting, not while building." >&2
fi

echo "==> writing manifest $manifest"
RELEASE="$release" APP_ID="morpheus-custody" NETWORK="$network" \
GIT_COMMIT="$git_commit" EIF_SHA256="$eif_sha256" HASH_ALGO="$hash_algo" \
PCR0="$pcr0" PCR1="$pcr1" PCR2="$pcr2" BUILT_AT="$built_at" IMAGE_ID="$image_id_1" \
jq -n '
  {
    release: env.RELEASE,
    app_id: env.APP_ID,
    network: env.NETWORK,
    git_commit: env.GIT_COMMIT,
    image_id: env.IMAGE_ID,
    eif_sha256: (if env.EIF_SHA256 == "" then null else env.EIF_SHA256 end),
    hash_algorithm: (env.HASH_ALGO // "SHA384"),
    pcr0: env.PCR0,
    pcr1: env.PCR1,
    pcr2: env.PCR2,
    built_at: env.BUILT_AT
  }
' >"$manifest"

echo "==> measurements captured:"
cat "$manifest"
echo
echo "==> DONE. Commit $manifest (review the PCRs) and ship it to the verifier."
echo "    The authoritative PCR0 pin for /provision lives in the custody KMS key"
echo "    policy (kms:RecipientAttestation:ImageSha384); keep it in step with this"
echo "    manifest, since baking the pin into the image would change the PCR0 it"
echo "    pins."
