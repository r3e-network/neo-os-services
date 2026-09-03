#!/usr/bin/env bash
set -euo pipefail

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

# The standalone signer image has no attestation-gated KMS materialization path.
# Refuse the historical host-held plaintext WIF workflow before starting an
# enclave. Operators must use Dockerfile.enclave + the merged server and provide
# only *_KMS_CIPHERTEXT_BASE64 values.
if [[ -r "$signer_env" ]]; then
  plaintext_key_pattern='^(MORPHEUS_ORACLE_VERIFIER_(WIF|PRIVATE_KEY)(_(MAINNET|TESTNET))?|MORPHEUS_UPDATER_NEO_N3_(WIF|PRIVATE_KEY)(_(MAINNET|TESTNET))?)=.+$'
  if grep -Eq "$plaintext_key_pattern" "$signer_env"; then
    echo "legacy Nitro signer refuses host-held plaintext keys; deploy the merged KMS-attested enclave" >&2
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
  --eif-path "$eif" >/opt/morpheus/nitro/morpheus-nitro-run.json

socat "TCP-LISTEN:${host_port},fork,reuseaddr,bind=127.0.0.1" "VSOCK-CONNECT:${cid}:${vsock_port}" &
socat_pid="$!"

cleanup() {
  kill "$socat_pid" >/dev/null 2>&1 || true
}
trap cleanup EXIT

for _ in $(seq 1 30); do
  if curl -sS --max-time 2 "http://127.0.0.1:${host_port}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if [[ -r "$signer_env" ]]; then
  MORPHEUS_NITRO_SIGNER_ENV="$signer_env" \
  MORPHEUS_NITRO_WORKER_ENV="$worker_env" \
  MORPHEUS_NITRO_FEED_ENV="$feed_env" \
  MORPHEUS_NITRO_HOST_PORT="$host_port" \
  node --input-type=module - <<'NODE'
import fs from 'node:fs';

const port = process.env.MORPHEUS_NITRO_HOST_PORT || '8787';
function parseEnv(path) {
  const values = {};
  try {
    for (const line of fs.readFileSync(path, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separator = trimmed.indexOf('=');
      if (separator <= 0) continue;
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim();
      if (/^[A-Z0-9_]{1,96}$/.test(key) && value) values[key] = value;
    }
  } catch {}
  return values;
}
const signer = parseEnv(process.env.MORPHEUS_NITRO_SIGNER_ENV);
const worker = parseEnv(process.env.MORPHEUS_NITRO_WORKER_ENV);
const feed = parseEnv(process.env.MORPHEUS_NITRO_FEED_ENV);
// The first token is operator-sealed under the enclave CMK. The parent presents
// the plaintext transport token, but the enclave accepts it only after KMS
// releases a matching, purpose/network/version-bound envelope to the expected
// PCR. Plaintext token fields are never copied into the provisioning body.
const token =
  signer.MORPHEUS_RUNTIME_TOKEN ||
  signer.NITRO_SIGNER_TOKEN ||
  signer.NITRO_API_TOKEN ||
  signer.NITRO_SHARED_SECRET ||
  '';
if (!token) {
  throw new Error(
    'Nitro signer provision requires MORPHEUS_RUNTIME_TOKEN, NITRO_SIGNER_TOKEN, NITRO_API_TOKEN, or NITRO_SHARED_SECRET'
  );
}
if (!signer.MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64) {
  throw new Error(
    'Nitro signer provision requires MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64'
  );
}
if (!signer.SIGNER_SERVICE_TOKEN_KMS_CIPHERTEXT_BASE64) {
  throw new Error(
    'Nitro signer provision requires SIGNER_SERVICE_TOKEN_KMS_CIPHERTEXT_BASE64'
  );
}

const provisionEnv = {
  MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64:
    signer.MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64,
  SIGNER_SERVICE_TOKEN_KMS_CIPHERTEXT_BASE64:
    signer.SIGNER_SERVICE_TOKEN_KMS_CIPHERTEXT_BASE64,
};
for (const key of [
  'AWS_REGION',
  'NITRO_AWS_REGION',
  'MORPHEUS_ORACLE_KMS_DIAG_CIPHERTEXT',
  'TWELVEDATA_API_KEY',
]) {
  if (worker[key]) provisionEnv[key] = worker[key];
}
if (feed.TD_KEY) provisionEnv.TD_KEY = feed.TD_KEY;

function projectCiphertext(target, pathKey, fallbackPath) {
  if (worker[target]) {
    provisionEnv[target] = worker[target];
    return;
  }
  const path = worker[pathKey] || fallbackPath;
  try {
    const ciphertext = fs.readFileSync(path, 'utf8').trim();
    if (ciphertext) provisionEnv[target] = ciphertext;
  } catch {}
}
projectCiphertext(
  'MORPHEUS_ORACLE_KMS_CIPHERTEXT_BASE64',
  'MORPHEUS_ORACLE_KMS_CIPHERTEXT_PATH',
  '/var/lib/morpheus/oracle-key-kms.b64'
);
projectCiphertext(
  'MORPHEUS_NEODID_SALT_KMS_CIPHERTEXT_BASE64',
  'MORPHEUS_NEODID_SALT_KMS_CIPHERTEXT_PATH',
  '/var/lib/morpheus/neodid-salt-kms.b64'
);

// KMS needs AWS request credentials, while RecipientAttestation ensures the
// returned plaintext is encrypted to an ephemeral key inside the enclave. Fetch
// short-lived instance-role credentials without putting them in argv or logs.
const metadataTokenResponse = await fetch('http://169.254.169.254/latest/api/token', {
  method: 'PUT',
  headers: { 'x-aws-ec2-metadata-token-ttl-seconds': '600' },
  signal: AbortSignal.timeout(5000),
});
if (!metadataTokenResponse.ok) throw new Error('IMDSv2 token request failed');
const metadataToken = await metadataTokenResponse.text();
const metadataHeaders = { 'x-aws-ec2-metadata-token': metadataToken };
const roleResponse = await fetch(
  'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
  { headers: metadataHeaders, signal: AbortSignal.timeout(5000) }
);
if (!roleResponse.ok) throw new Error('IMDSv2 role lookup failed');
const role = (await roleResponse.text()).trim();
if (!role) throw new Error('IMDSv2 returned an empty role name');
const credentialsResponse = await fetch(
  `http://169.254.169.254/latest/meta-data/iam/security-credentials/${encodeURIComponent(role)}`,
  { headers: metadataHeaders, signal: AbortSignal.timeout(5000) }
);
if (!credentialsResponse.ok) throw new Error('IMDSv2 credential lookup failed');
const credentials = await credentialsResponse.json();
provisionEnv.AWS_ACCESS_KEY_ID = credentials.AccessKeyId;
provisionEnv.AWS_SECRET_ACCESS_KEY = credentials.SecretAccessKey;
provisionEnv.AWS_SESSION_TOKEN = credentials.Token;

const response = await fetch(`http://127.0.0.1:${port}/provision`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({env: provisionEnv}),
});
if (!response.ok) {
  throw new Error(`Nitro signer provision failed: HTTP ${response.status}`);
}
const body = await response.json();
console.log(JSON.stringify({
  status: body.status,
  runtime: body.runtime,
  network: body.network,
  provisioned: body.provisioned,
  env_keys: body.env_keys,
  roles: (body.roles || []).map((entry) => ({
    role: entry.role,
    ok: entry.ok,
    identity: entry.identity,
    issues: entry.issues,
  })),
}));
NODE
fi

wait "$socat_pid"
