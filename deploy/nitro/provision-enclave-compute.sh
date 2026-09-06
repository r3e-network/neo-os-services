#!/usr/bin/env bash
# Rotate temporary AWS credentials after start-nitro-signer.sh completes the
# one-shot allowlisted provisioning ceremony. Runtime mode/network/endpoints,
# custody routing, policy switches, and trust anchors are measured image
# configuration; confidential inputs are KMS ciphertexts installed only on the
# first provision.
#
# This runs:
#   - after the signer service starts (PartOf + After); and
#   - on a 4h timer, to ROTATE the short-lived AWS instance-role credentials
#     (the price/VRF/feed lanes do not need AWS and stay up regardless; only the
#     decrypt/neodid lanes depend on the rotated creds).
#
# It is idempotent: /provision/credentials replaces exactly three AWS fields.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/nitro/lib/provisioning.sh
source "$script_dir/lib/provisioning.sh"

host_port="${MORPHEUS_NITRO_HOST_PORT:-8787}"
signer_env="${MORPHEUS_NITRO_SIGNER_ENV:-/opt/morpheus/nitro/morpheus-nitro-signer.env}"

# Wait for the enclave to answer /health (any HTTP status = the bridge is up).
ready=0
for _ in $(seq 1 60); do
  if curl -sS --max-time 2 -o /dev/null "http://127.0.0.1:${host_port}/health" 2>/dev/null; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "provision-enclave-compute: enclave /health not reachable on 127.0.0.1:${host_port}" >&2
  exit 1
fi

token="$(neoos_first_env_value "$signer_env" MORPHEUS_RUNTIME_TOKEN NITRO_SIGNER_TOKEN)"
neoos_require_printable_token "$token" 'provision-enclave-compute'
if ! neoos_fetch_imds_credentials; then
  echo 'provision-enclave-compute: IMDSv2 credential rotation failed; existing in-enclave credentials were left untouched' >&2
  exit 1
fi

payload="$(
  jq -n '{env: {
    AWS_ACCESS_KEY_ID: env.NEOOS_AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: env.NEOOS_AWS_SECRET_ACCESS_KEY,
    AWS_SESSION_TOKEN: env.NEOOS_AWS_SESSION_TOKEN
  }}'
)"
unset NEOOS_AWS_ACCESS_KEY_ID NEOOS_AWS_SECRET_ACCESS_KEY NEOOS_AWS_SESSION_TOKEN
neoos_post_json "http://127.0.0.1:${host_port}/provision/credentials" "$token" "$payload"
printf '%s' "$NEOOS_HTTP_BODY" | jq -c '{
  status,
  n_keys: ((.env_keys // []) | length),
  aws: true
}'
unset token payload NEOOS_HTTP_BODY NEOOS_HTTP_STATUS
