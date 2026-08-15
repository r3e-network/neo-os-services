#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

run_control_plane=1
run_oracle=1
run_verify=1
run_runtime_services=1

resolve_testnet_public_api_url() {
  node -e 'const fs = require("fs"); const path = require("path"); const repoRoot = process.argv[1]; const config = JSON.parse(fs.readFileSync(path.join(repoRoot, "config/networks/testnet.json"), "utf8")); process.stdout.write(String(config?.nitro?.public_api_url || ""));' "$REPO_ROOT"
}

usage() {
  cat <<'EOF_USAGE'
Usage: scripts/run_live_testnet_validation.sh [--smoke-only|--verify-only|--control-plane-only|--oracle-only|--runtime-services-only]

Runs live testnet validation for neo-os-services:
- public runtime api contract
- full runtime service matrix
- control-plane smoke
- oracle smoke
- verify:n3
EOF_USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --smoke-only)
      run_control_plane=1
      run_oracle=1
      run_verify=0
      run_runtime_services=1
      shift
      ;;
    --verify-only)
      run_control_plane=0
      run_oracle=0
      run_verify=1
      run_runtime_services=0
      shift
      ;;
    --control-plane-only)
      run_control_plane=1
      run_oracle=0
      run_verify=0
      run_runtime_services=0
      shift
      ;;
    --oracle-only)
      run_control_plane=0
      run_oracle=1
      run_verify=0
      run_runtime_services=0
      shift
      ;;
    --runtime-services-only)
      run_control_plane=0
      run_oracle=0
      run_verify=0
      run_runtime_services=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

cd "$REPO_ROOT"

MORPHEUS_PUBLIC_API_URL="${MORPHEUS_PUBLIC_API_URL:-$(resolve_testnet_public_api_url)}"
if [[ -z "$MORPHEUS_PUBLIC_API_URL" ]]; then
  echo "MORPHEUS_PUBLIC_API_URL is not configured and could not be derived from config/networks/testnet.json" >&2
  exit 1
fi

echo ""
echo "=== Public Runtime API Contract ==="
node scripts/check-public-runtime-api.mjs "$MORPHEUS_PUBLIC_API_URL"

if [[ $run_runtime_services -eq 1 ]]; then
  echo ""
  echo "=== Runtime Service Matrix ==="
  node scripts/live-validate-runtime-services.mjs --base-url "$MORPHEUS_PUBLIC_API_URL"
fi

if [[ $run_control_plane -eq 1 ]]; then
  echo ""
  echo "=== Control Plane Testnet Smoke ==="
  set +e
  npm run smoke:control-plane
  control_plane_status=$?
  set -e
  if [[ $control_plane_status -eq 75 ]]; then
    echo "[control-plane-smoke] skipped as inconclusive due to Cloudflare Workers plan rate limiting." >&2
  elif [[ $control_plane_status -eq 76 ]]; then
    echo "[control-plane-smoke] failed because Supabase storage quota blocks durable job acceptance." >&2
    exit $control_plane_status
  elif [[ $control_plane_status -ne 0 ]]; then
    exit $control_plane_status
  fi
fi

if [[ $run_oracle -eq 1 ]]; then
  echo ""
  echo "=== Oracle Testnet Smoke ==="
  npm run smoke:n3
fi

if [[ $run_verify -eq 1 ]]; then
  echo ""
  echo "=== Testnet Contract Verification ==="
  MORPHEUS_NETWORK=testnet npm run verify:n3
fi

echo ""
echo "Live testnet validation completed successfully."
