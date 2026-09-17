#!/usr/bin/env bash
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

eif="${MORPHEUS_NITRO_EIF:-/opt/morpheus/nitro/morpheus-oracle.eif}"
signer_env="${MORPHEUS_NITRO_SIGNER_ENV:-/opt/morpheus/nitro/morpheus-nitro-signer.env}"
worker_env="${MORPHEUS_NITRO_WORKER_ENV:-/opt/morpheus/nitro/nitro-worker.env}"
feed_env="${MORPHEUS_NITRO_FEED_ENV:-/opt/morpheus/nitro/feed-pusher.env}"
cid="${MORPHEUS_NITRO_CID:-16}"
cpu_count="${MORPHEUS_NITRO_CPU_COUNT:-2}"
memory_mib="${MORPHEUS_NITRO_MEMORY_MIB:-2048}"
host_port="${MORPHEUS_NITRO_HOST_PORT:-8787}"
vsock_port="${MORPHEUS_NITRO_VSOCK_PORT:-8787}"

if [[ ! -r "$eif" ]]; then
  echo "missing EIF: $eif" >&2
  exit 1
fi

# The standalone signer image has no custody signer integration and cannot be
# used in production. All signing MUST use the custody enclave via SIGNER_ROLE_*_KEY_ID.
# Refuse any attempt to provision host-held plaintext key material before starting an
# enclave. Operators must deploy Dockerfile.signer + the merged KMS-attested custody
# service and provide only *_KMS_CIPHERTEXT_BASE64 values (which will be rejected).
if [[ -r "$signer_env" ]]; then
  plaintext_key_pattern='^(MORPHEUS_ORACLE_VERIFIER_(WIF|PRIVATE_KEY)(_(MAINNET|TESTNET))?|MORPHEUS_UPDATER_NEO_N3_(WIF|PRIVATE_KEY)(_(MAINNET|TESTNET))?)=.+$'
  if grep -Eq "$plaintext_key_pattern" "$signer_env"; then
    echo "ERROR: No plaintext WIF/private keys allowed on any runtime process (S5)" >&2
    echo "All signing uses custody enclave via SIGNER_ROLE_*_KEY_ID" >&2
    exit 1
  fi
  if grep -Eq '^MORPHEUS_ALLOW_PLAINTEXT_KEY_PROVISION=.+$' "$signer_env"; then
    echo "MORPHEUS_ALLOW_PLAINTEXT_KEY_PROVISION is retired and cannot be enabled" >&2
    exit 1
  fi
fi
if nitro-cli describe-enclaves | jq -e ".[] | select(.EnclaveCID == ${cid})" >/dev/null; then
  existing_name="$(nitro-cli describe-enclaves | jq -r ".[] | select(.EnclaveCID == ${cid}) | .EnclaveName" | head -1)"
  if [[ "${MORPHEUS_NETWORK:-}" == "testnet" && "${existing_name}" != *testnet* ]]; then
    echo "testnet signer refuses to terminate foreign enclave ${existing_name} on CID ${cid}" >&2
    exit 1
  fi
  enclave_id="$(nitro-cli describe-enclaves | jq -r ".[] | select(.EnclaveCID == ${cid}) | .EnclaveID" | head -1)"
  nitro-cli terminate-enclave --enclave-id "$enclave_id" >/dev/null || true
fi

nitro-cli run-enclave \
  --cpu-count "$cpu_count" \
  --memory "$memory_mib" \
  --enclave-cid "$cid" \
  --eif-path "$eif" >/opt/morpheus/nitro/morpheus-nitro-run.json

socat "TCP-LISTEN:${host_port},fork,reuseaddr,bind=127.0.0.1" "VSOCK-CONNECT:${cid}:${vsock_port}" &
socat_pid="$!"

cleanup() {
  kill "$socat_pid" >/dev/null 2>&1 || true
}
trap cleanup EXIT

ready=0
for _ in $(seq 1 30); do
  if curl -sS --max-time 2 "http://127.0.0.1:${host_port}/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" -ne 1 ]]; then
  echo "Nitro frontier /health did not become reachable on 127.0.0.1:${host_port}" >&2
  exit 1
fi

if [[ -r "$signer_env" ]]; then
  token="$(neoos_first_env_value "$signer_env" MORPHEUS_RUNTIME_TOKEN NITRO_SIGNER_TOKEN NITRO_API_TOKEN NITRO_SHARED_SECRET)"
  runtime_token_ciphertext="$(neoos_env_value "$signer_env" MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64)"
  signer_token_ciphertext="$(neoos_env_value "$signer_env" SIGNER_SERVICE_TOKEN_KMS_CIPHERTEXT_BASE64)"
  neoos_require_printable_token "$token" 'Nitro frontier provision'
  neoos_require_base64 "$runtime_token_ciphertext" MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64
  neoos_require_base64 "$signer_token_ciphertext" SIGNER_SERVICE_TOKEN_KMS_CIPHERTEXT_BASE64

  oracle_ciphertext="$(neoos_env_value "$worker_env" MORPHEUS_ORACLE_KMS_CIPHERTEXT_BASE64)"
  if [[ -z "$oracle_ciphertext" ]]; then
    oracle_ciphertext_path="$(neoos_env_value "$worker_env" MORPHEUS_ORACLE_KMS_CIPHERTEXT_PATH)"
    oracle_ciphertext_path="${oracle_ciphertext_path:-/var/lib/morpheus/oracle-key-kms.b64}"
    [[ ! -r "$oracle_ciphertext_path" ]] || oracle_ciphertext="$(<"$oracle_ciphertext_path")"
  fi
  neodid_ciphertext="$(neoos_env_value "$worker_env" MORPHEUS_NEODID_SALT_KMS_CIPHERTEXT_BASE64)"
  if [[ -z "$neodid_ciphertext" ]]; then
    neodid_ciphertext_path="$(neoos_env_value "$worker_env" MORPHEUS_NEODID_SALT_KMS_CIPHERTEXT_PATH)"
    neodid_ciphertext_path="${neodid_ciphertext_path:-/var/lib/morpheus/neodid-salt-kms.b64}"
    [[ ! -r "$neodid_ciphertext_path" ]] || neodid_ciphertext="$(<"$neodid_ciphertext_path")"
  fi

  if ! neoos_fetch_imds_credentials; then
    echo 'Nitro frontier provision: IMDSv2 credential fetch failed' >&2
    exit 1
  fi

  export NEOOS_JSON_RUNTIME_TOKEN_CIPHERTEXT="$runtime_token_ciphertext"
  export NEOOS_JSON_SIGNER_TOKEN_CIPHERTEXT="$signer_token_ciphertext"
  export NEOOS_JSON_AWS_REGION="$(neoos_env_value "$worker_env" AWS_REGION)"
  export NEOOS_JSON_NITRO_AWS_REGION="$(neoos_env_value "$worker_env" NITRO_AWS_REGION)"
  export NEOOS_JSON_ORACLE_DIAG="$(neoos_env_value "$worker_env" MORPHEUS_ORACLE_KMS_DIAG_CIPHERTEXT)"
  export NEOOS_JSON_TWELVEDATA_API_KEY="$(neoos_env_value "$worker_env" TWELVEDATA_API_KEY)"
  export NEOOS_JSON_TD_KEY="$(neoos_env_value "$feed_env" TD_KEY)"
  export NEOOS_JSON_ORACLE_CIPHERTEXT="$oracle_ciphertext"
  export NEOOS_JSON_NEODID_CIPHERTEXT="$neodid_ciphertext"
  payload="$(
    jq -n '{env: ({
      MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64: env.NEOOS_JSON_RUNTIME_TOKEN_CIPHERTEXT,
      SIGNER_SERVICE_TOKEN_KMS_CIPHERTEXT_BASE64: env.NEOOS_JSON_SIGNER_TOKEN_CIPHERTEXT,
      AWS_REGION: env.NEOOS_JSON_AWS_REGION,
      NITRO_AWS_REGION: env.NEOOS_JSON_NITRO_AWS_REGION,
      MORPHEUS_ORACLE_KMS_DIAG_CIPHERTEXT: env.NEOOS_JSON_ORACLE_DIAG,
      TWELVEDATA_API_KEY: env.NEOOS_JSON_TWELVEDATA_API_KEY,
      TD_KEY: env.NEOOS_JSON_TD_KEY,
      MORPHEUS_ORACLE_KMS_CIPHERTEXT_BASE64: env.NEOOS_JSON_ORACLE_CIPHERTEXT,
      MORPHEUS_NEODID_SALT_KMS_CIPHERTEXT_BASE64: env.NEOOS_JSON_NEODID_CIPHERTEXT,
      AWS_ACCESS_KEY_ID: env.NEOOS_AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: env.NEOOS_AWS_SECRET_ACCESS_KEY,
      AWS_SESSION_TOKEN: env.NEOOS_AWS_SESSION_TOKEN
    } | with_entries(select(.value != "")))}'
  )"
  unset NEOOS_JSON_RUNTIME_TOKEN_CIPHERTEXT NEOOS_JSON_SIGNER_TOKEN_CIPHERTEXT
  unset NEOOS_JSON_AWS_REGION NEOOS_JSON_NITRO_AWS_REGION NEOOS_JSON_ORACLE_DIAG
  unset NEOOS_JSON_TWELVEDATA_API_KEY NEOOS_JSON_TD_KEY NEOOS_JSON_ORACLE_CIPHERTEXT
  unset NEOOS_JSON_NEODID_CIPHERTEXT
  unset NEOOS_AWS_ACCESS_KEY_ID NEOOS_AWS_SECRET_ACCESS_KEY NEOOS_AWS_SESSION_TOKEN

  neoos_post_json "http://127.0.0.1:${host_port}/provision" "$token" "$payload"
  printf '%s' "$NEOOS_HTTP_BODY" | jq -c '{
    status,
    runtime,
    network,
    provisioned,
    env_keys,
    roles: ((.roles // []) | map({role, ok, identity, issues}))
  }'
  if ! printf '%s' "$NEOOS_HTTP_BODY" | jq -e '
    (.roles // []) as $roles
    | (($roles | map(.role) | sort) == [
        "neox_updater",
        "neox_verifier",
        "oracle_verifier",
        "relayer",
        "updater",
        "worker"
      ])
      and ($roles | all(.ok == true))
  ' >/dev/null; then
    echo "ERROR: enclave provisioning did not materialize all six distinct measured custody roles" >&2
    unset token runtime_token_ciphertext signer_token_ciphertext
    unset oracle_ciphertext oracle_ciphertext_path neodid_ciphertext neodid_ciphertext_path payload
    unset NEOOS_HTTP_BODY NEOOS_HTTP_STATUS
    exit 1
  fi
  unset token runtime_token_ciphertext signer_token_ciphertext
  unset oracle_ciphertext oracle_ciphertext_path neodid_ciphertext neodid_ciphertext_path payload
  unset NEOOS_HTTP_BODY NEOOS_HTTP_STATUS
fi

wait "$socat_pid"
