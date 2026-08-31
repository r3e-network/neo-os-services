#!/usr/bin/env bash
# LEGACY builder: measures the retired Node-based signer image
# (Dockerfile.signer-legacy). The custody enclave — the Rust signer_service
# binary, zero Node — is built and measured by build-custody-eif.sh from
# Dockerfile.signer; that is the image start-nitro-custody.sh runs. This script
# exists only so the historical EIF path keeps building while deployments move.
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
docker build -f "$repo_root/deploy/nitro/Dockerfile.signer-legacy" -t "$image" "$repo_root"
nitro-cli build-enclave --docker-uri "$image" --output-file "$output"
