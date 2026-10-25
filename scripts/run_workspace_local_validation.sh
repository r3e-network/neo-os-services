#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICES_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKSPACE_ROOT="$(cd "$SERVICES_ROOT/.." && pwd)"
AA_ROOT="${AA_ROOT:-$WORKSPACE_ROOT/neo-os-aa}"
PLATFORM_ROOT="${PLATFORM_ROOT:-${MINIAPPS_ROOT:-$WORKSPACE_ROOT/neo-os-web}}"

run_services=1
run_aa=1
run_platform=1

usage() {
  cat <<'EOF'
Usage: scripts/run_workspace_local_validation.sh [--services-only|--aa-only|--platform-only]

Runs local validation gates across the NeoOS workspace:
- neo-os-services
- neo-os-aa
- neo-os-web

Compatibility aliases: --oracle-only, --miniapps-only, MINIAPPS_ROOT.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --services-only|--oracle-only)
      run_services=1
      run_aa=0
      run_platform=0
      shift
      ;;
    --aa-only)
      run_services=0
      run_aa=1
      run_platform=0
      shift
      ;;
    --platform-only|--miniapps-only)
      run_services=0
      run_aa=0
      run_platform=1
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

if [[ $run_services -eq 1 ]]; then
  echo ""
  echo "=== NeoOS Services Local Validation ==="
  (cd "$SERVICES_ROOT" && npm run test:testnet:local-gates)
fi

if [[ $run_aa -eq 1 ]]; then
  echo ""
  echo "=== AA Local Validation ==="
  (cd "$AA_ROOT" && bash scripts/verify_repo.sh --skip-contract-build --skip-e2e)
fi

if [[ $run_platform -eq 1 ]]; then
  echo ""
  echo "=== NeoOS Web Platform Local Validation ==="
  (cd "$PLATFORM_ROOT" && npm run test:testnet:local-gates)
fi

echo ""
echo "Workspace local validation completed successfully."
