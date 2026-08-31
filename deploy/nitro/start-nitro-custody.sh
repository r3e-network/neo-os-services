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
set -euo pipefail

env_file="${MORPHEUS_NITRO_ENV:-/opt/morpheus/nitro/morpheus-nitro.env}"
if [[ -f "$env_file" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$env_file"
  set +a
fi

eif="${MORPHEUS_CUSTODY_EIF:-/opt/morpheus/nitro/morpheus-custody.eif}"
signer_env="${MORPHEUS_CUSTODY_SIGNER_ENV:-/opt/morpheus/nitro/morpheus-custody-signer.env}"
cid="${MORPHEUS_CUSTODY_CID:-16}"
cpu_count="${MORPHEUS_CUSTODY_CPU_COUNT:-2}"
memory_mib="${MORPHEUS_CUSTODY_MEMORY_MIB:-2048}"
host_port="${MORPHEUS_CUSTODY_HOST_PORT:-8787}"
vsock_port="${MORPHEUS_CUSTODY_VSOCK_PORT:-8787}"

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

for _ in $(seq 1 60); do
  if curl -sS --max-time 2 "http://127.0.0.1:${host_port}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if [[ -r "$signer_env" ]]; then
  MORPHEUS_CUSTODY_SIGNER_ENV="$signer_env" \
  MORPHEUS_CUSTODY_HOST_PORT="$host_port" \
  node --input-type=module - <<'NODE'
import fs from 'node:fs';

const envPath = process.env.MORPHEUS_CUSTODY_SIGNER_ENV;
const port = process.env.MORPHEUS_CUSTODY_HOST_PORT || '8787';
const env = {};
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const separator = trimmed.indexOf('=');
  if (separator <= 0) continue;
  const key = trimmed.slice(0, separator).trim();
  const value = trimmed.slice(separator + 1).trim();
  if (/^[A-Z0-9_]{1,96}$/.test(key) && value) env[key] = value;
}

// The first token is operator-sealed under the enclave CMK. The parent
// presents the plaintext transport token, but the enclave accepts it only
// after KMS releases a matching, purpose-bound envelope to the attested
// enclave; plaintext key material is never copied into the provisioning body.
const token =
  env.MORPHEUS_RUNTIME_TOKEN ||
  env.NITRO_SIGNER_TOKEN ||
  env.NITRO_API_TOKEN ||
  env.NITRO_SHARED_SECRET ||
  '';
const tokenCiphertext = env.MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64;
const masterCiphertext = env.SIGNER_SERVICE_MASTER_KEY_KMS_CIPHERTEXT;
const region =
  env.SIGNER_SERVICE_KMS_REGION || env.AWS_REGION || env.AWS_DEFAULT_REGION || '';
if (!token) {
  throw new Error(
    'custody provision requires MORPHEUS_RUNTIME_TOKEN, NITRO_SIGNER_TOKEN, NITRO_API_TOKEN, or NITRO_SHARED_SECRET'
  );
}
if (!tokenCiphertext) {
  throw new Error('custody provision requires MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64');
}
if (!masterCiphertext) {
  throw new Error('custody provision requires SIGNER_SERVICE_MASTER_KEY_KMS_CIPHERTEXT');
}
if (!region) {
  throw new Error('custody provision requires SIGNER_SERVICE_KMS_REGION (or AWS_REGION)');
}
// Host-side sanity on the values the whitelist will receive; the enclave
// validates membership and shape again, fail-closed.
if (!/^[\x21-\x7E]{8,512}$/.test(token)) {
  throw new Error('runtime token must be 8-512 printable ASCII characters');
}
const base64Pattern = /^[A-Za-z0-9+/=]+$/;
if (!base64Pattern.test(tokenCiphertext) || !base64Pattern.test(masterCiphertext)) {
  throw new Error('KMS ciphertexts must be base64');
}
if (!/^[a-z0-9-]{2,32}$/.test(region)) {
  throw new Error('KMS region must look like a region name');
}

// KMS needs AWS request credentials, while RecipientAttestation ensures the
// returned plaintext is encrypted to an ephemeral key inside the enclave.
// Fetch short-lived instance-role credentials without putting them in argv
// or logs.
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

// The provision whitelist, projected exactly: nothing else in the env file
// crosses the boundary (the enclave refuses unknown keys with 400).
const provisionEnv = {
  MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64: tokenCiphertext,
  SIGNER_SERVICE_MASTER_KEY_KMS_CIPHERTEXT: masterCiphertext,
  SIGNER_SERVICE_KMS_REGION: region,
  AWS_ACCESS_KEY_ID: credentials.AccessKeyId,
  AWS_SECRET_ACCESS_KEY: credentials.SecretAccessKey,
};
if (credentials.Token) provisionEnv.AWS_SESSION_TOKEN = credentials.Token;

const response = await fetch(`http://127.0.0.1:${port}/provision`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({env: provisionEnv}),
});
if (!response.ok) {
  throw new Error(`custody provision failed: HTTP ${response.status}`);
}
const body = await response.json();
console.log(JSON.stringify({
  status: body.status,
  vault_fingerprint: body.vault_fingerprint,
}));
NODE
fi

wait "$socat_pid"
