#!/usr/bin/env bash
# Run the complete NeoNexus v1 client contract against a disposable Rust signer.
#
# The custody-service repository owns this harness because it owns the wire
# contract and process lifecycle. The sibling consumer supplies only its test
# module. No token is printed, no fixed port is reserved, and the vault is
# removed on success, failure, or interruption.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
services_root="$(cd -- "$script_dir/.." && pwd -P)"
nexus_candidate="${NEO_NEXUS_DIR:-$services_root/../../neo-nexus}"

if [[ ! -f "$nexus_candidate/Cargo.toml" || ! -f "$nexus_candidate/tests/unit/signer_client/client/tests.rs" ]]; then
  echo "NEO_NEXUS_DIR must point at a NeoNexus checkout" >&2
  exit 2
fi
nexus_root="$(cd -- "$nexus_candidate" && pwd -P)"

contract_tmp="$(mktemp -d "${TMPDIR:-/tmp}/neo-nexus-signer-contract.XXXXXX")"
signer_pid=""

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n "$signer_pid" ]] && kill -0 "$signer_pid" 2>/dev/null; then
    kill -TERM "$signer_pid" 2>/dev/null || true
    wait "$signer_pid" 2>/dev/null || true
  fi
  rm -rf -- "$contract_tmp"
  exit "$status"
}
trap cleanup EXIT INT TERM

umask 077
vault_dir="$contract_tmp/vault"
admin_token_file="$contract_tmp/admin.token"
signer_stdout="$contract_tmp/signer.stdout"
signer_stderr="$contract_tmp/signer.stderr"
mkdir -p -- "$vault_dir"

# This is a host-mode contract with a disposable, file-backed vault. Operator
# shell settings for enclave boot, KMS/master-key material, body limits, or
# admission control must not turn the test into a different deployment mode.
unset SIGNER_SERVICE_ATTESTED_BOOT SIGNER_SERVICE_EXPECTED_PCR0
unset SIGNER_SERVICE_MASTER_KEY SIGNER_SERVICE_MASTER_KEY_KMS_CIPHERTEXT
unset SIGNER_SERVICE_KMS_REGION SIGNER_SERVICE_TOKEN SIGNER_SERVICE_URL
unset SIGNER_SERVICE_MAX_BODY_BYTES SIGNER_SERVICE_MAX_IN_FLIGHT_REQUESTS

# Run from the owning checkout so Cargo and the lookup below resolve a relative
# CARGO_TARGET_DIR against the same directory, independent of the caller's cwd.
(
  cd -- "$services_root"
  cargo build \
    --locked \
    -p neo-signer \
    --bin signer_service
)

services_target="${CARGO_TARGET_DIR:-$services_root/target}"
if [[ "$services_target" != /* ]]; then
  services_target="$services_root/$services_target"
fi
signer_binary="$services_target/debug/signer_service"
if [[ ! -x "$signer_binary" ]]; then
  echo "signer binary was not produced at $signer_binary" >&2
  exit 1
fi

admin_token="$(SIGNER_SERVICE_DATA_DIR="$vault_dir" "$signer_binary" provision-admin "neo-nexus CI contract")"
if [[ -z "$admin_token" || "$admin_token" == *$'\n'* ]]; then
  echo "signer provision-admin returned an invalid token shape" >&2
  exit 1
fi
printf '%s\n' "$admin_token" > "$admin_token_file"
unset admin_token
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    admin_token_file_windows="$(cygpath -w "$admin_token_file")"
    icacls.exe "$admin_token_file_windows" \
      /inheritance:r \
      /grant:r "${USERNAME:?Windows account name is unavailable}:(F)" \
      >/dev/null
    ;;
  *)
    chmod 600 "$admin_token_file"
    ;;
esac

SIGNER_SERVICE_DATA_DIR="$vault_dir" \
SIGNER_SERVICE_HOST="127.0.0.1" \
SIGNER_SERVICE_PORT="0" \
"$signer_binary" serve >"$signer_stdout" 2>"$signer_stderr" &
signer_pid=$!

signer_port=""
for _ in $(seq 1 120); do
  signer_port="$(sed -nE 's/.*listening on 127\.0\.0\.1:([0-9]+).*/\1/p' "$signer_stderr" | tail -n 1)"
  if [[ -n "$signer_port" ]] && curl --fail --silent --show-error "http://127.0.0.1:$signer_port/health" >/dev/null; then
    break
  fi
  if ! kill -0 "$signer_pid" 2>/dev/null; then
    echo "signer exited before becoming ready" >&2
    sed -n '1,160p' "$signer_stderr" >&2
    exit 1
  fi
  sleep 0.25
done
if [[ -z "$signer_port" ]]; then
  echo "signer did not report a bound port" >&2
  sed -n '1,160p' "$signer_stderr" >&2
  exit 1
fi
if ! curl --fail --silent --show-error "http://127.0.0.1:$signer_port/health" >/dev/null; then
  echo "signer did not become healthy" >&2
  sed -n '1,160p' "$signer_stderr" >&2
  exit 1
fi

# Inherited developer-machine configuration must not select a second profile,
# alter the server-to-server origin boundary, shorten the request budget, or
# use the deprecated aliases while the harness proves the canonical profile.
unset NEONEXUS_SIGNER_SERVICE_URL NEONEXUS_SIGNER_SERVICE_TOKEN
unset NEONEXUS_SIGNER_SERVICE_ORIGIN NEONEXUS_SIGNER_SERVICE_TIMEOUT_SECONDS
unset NEONEXUS_SIGNER_ADMIN_CALLER_ID NEONEXUS_SIGNER_ADMIN_WORKLOAD_KEY_FILE
unset NEONEXUS_SIGNER_ADMIN_WORKLOAD_SUBJECT

NEONEXUS_SIGNER_URL="http://127.0.0.1:$signer_port" \
NEONEXUS_SIGNER_ADMIN_TOKEN_FILE="$admin_token_file" \
cargo test \
  --manifest-path "$nexus_root/Cargo.toml" \
  --lib \
  signer_client::client::tests::a_real_service_and_this_client_agree_on_every_supported_route \
  -- \
  --ignored \
  --exact \
  --nocapture

echo "neo-nexus signer contract: passed against disposable Rust signer"
