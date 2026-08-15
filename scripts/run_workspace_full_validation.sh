#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

run_local=1
run_live=1
scope_args=()

usage() {
  cat <<'EOF'
Usage: scripts/run_workspace_full_validation.sh [--skip-local|--skip-live|--services-only|--aa-only|--platform-only]

Composition:
- workspace local validation
- workspace live validation
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-local)
      run_local=0
      shift
      ;;
    --skip-live)
      run_live=0
      shift
      ;;
    --services-only|--oracle-only|--aa-only|--platform-only|--miniapps-only)
      scope_args+=("$1")
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

if [[ $run_local -eq 1 ]]; then
  if [[ ${#scope_args[@]} -gt 0 ]]; then
    bash "$SCRIPT_DIR/run_workspace_local_validation.sh" "${scope_args[@]}"
  else
    bash "$SCRIPT_DIR/run_workspace_local_validation.sh"
  fi
fi

if [[ $run_live -eq 1 ]]; then
  if [[ ${#scope_args[@]} -gt 0 ]]; then
    bash "$SCRIPT_DIR/run_workspace_live_validation.sh" "${scope_args[@]}"
  else
    bash "$SCRIPT_DIR/run_workspace_live_validation.sh"
  fi
fi

echo ""
echo "Workspace full validation completed successfully."
