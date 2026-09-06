#!/usr/bin/env bash
# Start the custody enclave (Dockerfile.signer image, measured by
# build-custody-eif.sh) and provision it: release the transport token and the
# vault master key through the attested KMS path (RC2) via POST /provision.
#
# The enclave boots with the vault sealed — every custody route answers 503
# signer-not-provisioned until this script's provision step succeeds, and
# provisioning happens exactly once per boot (a second call answers 409).
# Plaintext key material never enters this flow: the host presents only the
# plaintext transport token (as the Bearer credential the enclave validates
# against a KMS-released envelope) and the two KMS ciphertexts. The AWS
# credentials come from the instance role over IMDSv2 at start time and are
# never written to disk or logs.
#
# Topology: a host runs TWO enclaves. The frontier (start-nitro-signer.sh,
# morpheus-oracle.eif, built from Dockerfile.enclave) owns CID 16 and host port
# 8787 — that is the endpoint every consumer's MORPHEUS_RUNTIME_URL /
# NITRO_API_URL / SIGNER_URL names, and where provision-enclave-compute.sh
# pushes the compute config. Custody is the second one, so its defaults are
# deliberately different (CID 17, host port 8789) and the guard below refuses a
# configuration that puts them back on top of each other: this script terminates
# whatever enclave holds its CID before booting, so a shared CID means "kill the
# frontier", and a shared host port means the socat bind fails with EADDRINUSE
# against the frontier's still-live bridge. Both scripts source the same
# morpheus-nitro.env, which is exactly how the two get set to the same value.
# The vsock port stays 8787: it is per-enclave (CID 17 here), and it must match
# NITRO_SIGNER_VSOCK_PORT baked into the measured image — changing it changes
# what nitro_init listens on inside the enclave, i.e. changes PCR0.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/nitro/lib/provisioning.sh
source "$script_dir/lib/provisioning.sh"

env_file="${MORPHEUS_NITRO_ENV:-/opt/morpheus/nitro/morpheus-nitro.env}"
if [[ -f "$env_file" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$env_file"
  set +a
fi

eif="${MORPHEUS_CUSTODY_EIF:-/opt/morpheus/nitro/morpheus-custody.eif}"
signer_env="${MORPHEUS_CUSTODY_SIGNER_ENV:-/opt/morpheus/nitro/morpheus-custody-signer.env}"
cid="${MORPHEUS_CUSTODY_CID:-17}"
cpu_count="${MORPHEUS_CUSTODY_CPU_COUNT:-2}"
memory_mib="${MORPHEUS_CUSTODY_MEMORY_MIB:-2048}"
host_port="${MORPHEUS_CUSTODY_HOST_PORT:-8789}"
vsock_port="${MORPHEUS_CUSTODY_VSOCK_PORT:-8787}"

# Only a DECLARED frontier value is a collision: a custody-only host is free to
# use CID 16 or port 8787, and inventing a frontier that is not configured here
# would refuse it for no reason.
collision=""
if [[ -n "${MORPHEUS_NITRO_CID:-}" && "$cid" == "${MORPHEUS_NITRO_CID}" ]]; then
  collision="CID $cid"
fi
if [[ -n "${MORPHEUS_NITRO_HOST_PORT:-}" && "$host_port" == "${MORPHEUS_NITRO_HOST_PORT}" ]]; then
  collision="${collision:+$collision and }host port $host_port"
fi
if [[ -n "$collision" ]]; then
  echo "custody enclave collides with the frontier enclave on $collision" >&2
  echo "  this script terminates the enclave holding its CID before booting, so the" >&2
  echo "  frontier would be killed and its consumers (MORPHEUS_RUNTIME_URL /" >&2
  echo "  NITRO_API_URL / provision-enclave-compute.sh) would reach custody instead." >&2
  echo "  Set MORPHEUS_CUSTODY_CID / MORPHEUS_CUSTODY_HOST_PORT to distinct values." >&2
  exit 1
fi

if [[ ! -r "$eif" ]]; then
  echo "missing EIF: $eif" >&2
  exit 1
fi

# RC2 at the host boundary, mirroring the enclave's own boot refusal: a
# plaintext master key in the provisioning env is a configuration this flow
# exists to retire. (SIGNER_SERVICE_MASTER_KEY is also the one name the
# enclave's /provision whitelist rejects with 403 before anything else.)
if [[ -r "$signer_env" ]]; then
  if grep -Eq '^SIGNER_SERVICE_MASTER_KEY=.+$' "$signer_env"; then
    echo "custody enclave refuses host-held plaintext master keys; release it through /provision via SIGNER_SERVICE_MASTER_KEY_KMS_CIPHERTEXT" >&2
    exit 1
  fi
  if grep -Eq '^MORPHEUS_ALLOW_PLAINTEXT_KEY_PROVISION=.+$' "$signer_env"; then
    echo "MORPHEUS_ALLOW_PLAINTEXT_KEY_PROVISION is retired and cannot be enabled" >&2
    exit 1
  fi
fi

if nitro-cli describe-enclaves | jq -e ".[] | select(.EnclaveCID == ${cid})" >/dev/null; then
  enclave_id="$(nitro-cli describe-enclaves | jq -r ".[] | select(.EnclaveCID == ${cid}) | .EnclaveID" | head -1)"
  nitro-cli terminate-enclave --enclave-id "$enclave_id" >/dev/null || true
fi

nitro-cli run-enclave \
  --cpu-count "$cpu_count" \
  --memory "$memory_mib" \
  --enclave-cid "$cid" \
  --eif-path "$eif" >/opt/morpheus/nitro/morpheus-custody-run.json

socat "TCP-LISTEN:${host_port},fork,reuseaddr,bind=127.0.0.1" "VSOCK-CONNECT:${cid}:${vsock_port}" &
socat_pid="$!"

cleanup() {
  kill "$socat_pid" >/dev/null 2>&1 || true
}
trap cleanup EXIT

ready=0
for _ in $(seq 1 60); do
  if curl -sS --max-time 2 "http://127.0.0.1:${host_port}/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" -ne 1 ]]; then
  echo "custody enclave /health did not become reachable on 127.0.0.1:${host_port}" >&2
  exit 1
fi

if [[ -r "$signer_env" ]]; then
  token="$(neoos_first_env_value "$signer_env" MORPHEUS_RUNTIME_TOKEN NITRO_SIGNER_TOKEN NITRO_API_TOKEN NITRO_SHARED_SECRET)"
  token_ciphertext="$(neoos_env_value "$signer_env" MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64)"
  master_ciphertext="$(neoos_env_value "$signer_env" SIGNER_SERVICE_MASTER_KEY_KMS_CIPHERTEXT)"
  kms_region="$(neoos_first_env_value "$signer_env" SIGNER_SERVICE_KMS_REGION AWS_REGION AWS_DEFAULT_REGION)"

  neoos_require_printable_token "$token" 'custody provision'
  neoos_require_base64 "$token_ciphertext" MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64
  neoos_require_base64 "$master_ciphertext" SIGNER_SERVICE_MASTER_KEY_KMS_CIPHERTEXT
  if [[ ! "$kms_region" =~ ^[a-z0-9-]{2,32}$ ]]; then
    echo 'SIGNER_SERVICE_KMS_REGION (or AWS_REGION) must look like an AWS region name' >&2
    exit 1
  fi
  if ! neoos_fetch_imds_credentials; then
    echo 'custody provision: IMDSv2 credential fetch failed' >&2
    exit 1
  fi

  export NEOOS_JSON_TOKEN_CIPHERTEXT="$token_ciphertext"
  export NEOOS_JSON_MASTER_CIPHERTEXT="$master_ciphertext"
  export NEOOS_JSON_KMS_REGION="$kms_region"
  payload="$(
    jq -n '{env: ({
      MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64: env.NEOOS_JSON_TOKEN_CIPHERTEXT,
      SIGNER_SERVICE_MASTER_KEY_KMS_CIPHERTEXT: env.NEOOS_JSON_MASTER_CIPHERTEXT,
      SIGNER_SERVICE_KMS_REGION: env.NEOOS_JSON_KMS_REGION,
      AWS_ACCESS_KEY_ID: env.NEOOS_AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: env.NEOOS_AWS_SECRET_ACCESS_KEY,
      AWS_SESSION_TOKEN: env.NEOOS_AWS_SESSION_TOKEN
    } | with_entries(select(.value != "")))}'
  )"
  unset NEOOS_JSON_TOKEN_CIPHERTEXT NEOOS_JSON_MASTER_CIPHERTEXT NEOOS_JSON_KMS_REGION
  unset NEOOS_AWS_ACCESS_KEY_ID NEOOS_AWS_SECRET_ACCESS_KEY NEOOS_AWS_SESSION_TOKEN

  neoos_post_json "http://127.0.0.1:${host_port}/provision" "$token" "$payload"
  printf '%s' "$NEOOS_HTTP_BODY" | jq -c '{status, vault_fingerprint}'
  unset token token_ciphertext master_ciphertext kms_region payload
  unset NEOOS_HTTP_BODY NEOOS_HTTP_STATUS
else
  # Not fatal — booting unprovisioned is how you smoke-test a fresh EIF — but it
  # must not be quiet: the bridge comes up, /health answers, and every custody
  # route then refuses with 503 forever, which reads as a service bug rather
  # than a missing file.
  echo "WARNING: $signer_env is not readable, so /provision was never called." >&2
  echo "         The enclave stays sealed: /health reports unprovisioned and every" >&2
  echo "         custody and management route answers 503 signer-not-provisioned." >&2
  echo "         Provisioning happens once per boot; a restart re-seals the vault." >&2
fi

wait "$socat_pid"
