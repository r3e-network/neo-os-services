#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

run_worker=1
run_engine_sync=1
run_relayer=1
run_control_plane=1
run_web=1

usage() {
  cat <<'EOF'
Usage: scripts/run_local_validation_gates.sh [--worker-only|--relayer-only|--control-plane-only|--web-only]

Runs local validation gates for neo-os-services:
- worker test suite
- relayer test suite
- control-plane test suite
- web build + content consistency
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --worker-only)
      run_worker=1
      run_relayer=0
      run_control_plane=0
      run_web=0
      shift
      ;;
    --relayer-only)
      run_worker=0
      run_engine_sync=0
      run_relayer=1
      run_control_plane=0
      run_web=0
      shift
      ;;
    --control-plane-only)
      run_worker=0
      run_engine_sync=0
      run_relayer=0
      run_control_plane=1
      run_web=0
      shift
      ;;
    --web-only)
      run_worker=0
      run_engine_sync=0
      run_relayer=0
      run_control_plane=0
      run_web=1
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

if [[ $run_engine_sync -eq 1 ]]; then
  echo ""
  echo "=== Cross-Repo Game Engine Sync Gate ==="
  npm run test:game-engine-sync
fi

if [[ $run_worker -eq 1 ]]; then
  echo ""
  echo "=== Worker Local Gates ==="
  npm run test:worker
fi

if [[ $run_relayer -eq 1 ]]; then
  echo ""
  echo "=== Relayer Local Gates ==="
  npm run test:relayer
  npm run test:relayer:compat
fi

if [[ $run_control_plane -eq 1 ]]; then
  echo ""
  echo "=== Control Plane Local Gates ==="
  npm run test:control-plane
fi

if [[ $run_web -eq 1 ]]; then
  export MORPHEUS_NETWORK="${MORPHEUS_NETWORK:-${NEXT_PUBLIC_MORPHEUS_NETWORK:-testnet}}"
  export NEXT_PUBLIC_MORPHEUS_NETWORK="${NEXT_PUBLIC_MORPHEUS_NETWORK:-$MORPHEUS_NETWORK}"
  echo ""
  echo "=== Web Local Gates ==="
  npm --prefix apps/web run test:run
  npm run build:web
  npm run check:web-content
fi

echo ""
echo "Local validation gates completed successfully."
