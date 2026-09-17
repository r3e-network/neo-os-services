#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

LOCK_DIR="/tmp/neo-os-services.verify_repo.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "[verify:repo] another verification appears to be running (lock: $LOCK_DIR)" >&2
  exit 75
fi
cleanup() {
  kill_web_builders || true
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

kill_web_builders() {
  if ! command -v pgrep >/dev/null 2>&1; then
    return 0
  fi
  local pids
  pids="$(
    {
      pgrep -f "$ROOT_DIR/node_modules/.bin/next build" || true
      pgrep -f "$ROOT_DIR/apps/web/node_modules/.bin/next build" || true
      pgrep -f "$ROOT_DIR/apps/web/.*/next build" || true
    } | tr ' ' '\n' | awk 'NF' | sort -u | paste -sd' ' -
  )"
  if [ -n "$pids" ]; then
    echo "[verify:repo] cleaning up stale Next.js build processes: $pids" >&2
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      sleep 0.5
      local still_running=""
      for pid in $pids; do
        if ps -p "$pid" >/dev/null 2>&1; then
          still_running="$still_running $pid"
        fi
      done
      if [ -z "${still_running// /}" ]; then
        break
      fi
    done
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
  fi
}

npm run check:audit:root
npm run check:rust-migration
npm run check:production-topology
npm run check:cargo-lock-provenance
npm run format:rust:check
npm run check:rust
npm run test:rust
npm run test:scripts
npm run test:game-engine-sync
npm run test:control-plane
npm run check:worker
npm run test:worker
npm run check:relayer
npm run test:relayer
npm run check:relayer:compat
npm run test:relayer:compat
npm run check:brand
npm run check:web-content
npm --prefix apps/web run test:run
attempt=1
max_attempts=3
while :; do
  kill_web_builders
  rm -rf apps/web/.next
  if npm run build:web; then
    break
  fi

  if [ "$attempt" -ge "$max_attempts" ]; then
    echo "[verify:repo] web build failed after ${max_attempts} attempts" >&2
    exit 1
  fi

  attempt=$((attempt + 1))
  echo "[verify:repo] web build failed; retrying (${attempt}/${max_attempts}) after cleanup" >&2
  kill_web_builders
done
npm run lint -- --max-warnings=0
