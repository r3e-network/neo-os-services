#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
image="${MORPHEUS_NITRO_IMAGE:-morpheus-nitro-signer:latest}"
output="${MORPHEUS_NITRO_EIF:-/opt/morpheus/nitro/morpheus-nitro-signer.eif}"
artifacts="${NITRO_CLI_ARTIFACTS:-/opt/morpheus/nitro/artifacts}"
blobs="${NITRO_CLI_BLOBS:-/usr/share/nitro_enclaves/blobs}"

mkdir -p "$(dirname "$output")"
mkdir -p "$artifacts"
export NITRO_CLI_ARTIFACTS="$artifacts"
export NITRO_CLI_BLOBS="$blobs"
docker build -f "$repo_root/deploy/nitro/Dockerfile.signer" -t "$image" "$repo_root"
nitro-cli build-enclave --docker-uri "$image" --output-file "$output"
