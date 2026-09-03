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

host_port="${MORPHEUS_NITRO_HOST_PORT:-8787}"
signer_env="${MORPHEUS_NITRO_SIGNER_ENV:-/opt/morpheus/nitro/morpheus-nitro-signer.env}"
worker_env="${MORPHEUS_NITRO_WORKER_ENV:-/opt/morpheus/nitro/nitro-worker.env}"
feed_env="${MORPHEUS_NITRO_FEED_ENV:-/opt/morpheus/nitro/feed-pusher.env}"

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

MORPHEUS_NITRO_HOST_PORT="$host_port" \
SIGNER_ENV="$signer_env" WORKER_ENV="$worker_env" FEED_ENV="$feed_env" \
node --input-type=module - <<'NODE'
import fs from 'node:fs';
import cp from 'node:child_process';

const port = process.env.MORPHEUS_NITRO_HOST_PORT;
function parseEnv(p) {
  const o = {};
  try {
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i <= 0) continue;
      const k = t.slice(0, i).trim();
      const v = t.slice(i + 1).trim();
      if (/^[A-Z0-9_]{1,96}$/.test(k) && v) o[k] = v;
    }
  } catch {}
  return o;
}

const signer = parseEnv(process.env.SIGNER_ENV);
const env = {};

// Fresh instance-role credentials from IMDSv2 so the in-enclave decrypt/neodid
// lane can submit future recipient-attested KMS requests. No Secrets Manager
// permission is needed or allowed.
try {
  const tok = cp
    .execSync('curl -sS -X PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 600"', { timeout: 5000 })
    .toString();
  const role = cp
    .execSync(`curl -sS -H "X-aws-ec2-metadata-token: ${tok}" http://169.254.169.254/latest/meta-data/iam/security-credentials/`, { timeout: 5000 })
    .toString()
    .trim();
  const c = JSON.parse(
    cp
      .execSync(`curl -sS -H "X-aws-ec2-metadata-token: ${tok}" http://169.254.169.254/latest/meta-data/iam/security-credentials/${role}`, { timeout: 5000 })
      .toString()
  );
  env.AWS_ACCESS_KEY_ID = c.AccessKeyId;
  env.AWS_SECRET_ACCESS_KEY = c.SecretAccessKey;
  env.AWS_SESSION_TOKEN = c.Token;
} catch (e) {
  console.error('provision-enclave-compute: IMDS cred fetch failed (decrypt/neodid lanes may degrade):', e.message);
}

const token = signer.MORPHEUS_RUNTIME_TOKEN || signer.NITRO_SIGNER_TOKEN || '';
const res = await fetch(`http://127.0.0.1:${port}/provision/credentials`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
  body: JSON.stringify({ env }),
});
const body = await res.json().catch(() => ({}));
console.log(
  JSON.stringify({
    status: body.status,
    n_keys: (body.env_keys || []).length,
    aws: Boolean(env.AWS_ACCESS_KEY_ID),
  })
);
if (!res.ok) process.exit(1);
NODE
