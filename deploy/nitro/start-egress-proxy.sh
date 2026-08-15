#!/usr/bin/env bash
# Host egress service for the Nitro enclave: runs the allow-listed HTTP-CONNECT
# proxy (host-egress-proxy.mjs) and a socat VSOCK-LISTEN bridge that exposes it to
# the enclave over vsock. The enclave's in-entrypoint socat connects to
# VSOCK CID3:EGRESS_VSOCK_PORT; this bridge forwards that to the local proxy.
#
#   enclave 127.0.0.1:3128 (socat) -> vsock CID3:8788 -> [this] socat VSOCK-LISTEN
#     -> 127.0.0.1:13128 (host-egress-proxy.mjs) -> allow-listed real provider
#
# Both children are polled; if either dies the script exits so systemd restarts a
# clean pair (Restart=on-failure).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
proxy_port="${ENCLAVE_EGRESS_PROXY_PORT:-13128}"
vsock_port="${ENCLAVE_EGRESS_VSOCK_PORT:-8788}"
allowlist="${ENCLAVE_EGRESS_ALLOWLIST:-$repo_root/deploy/nitro/vsock-proxy.allowlist.yaml}"

node_pid=""
socat_pid=""
cleanup() {
  [ -n "$node_pid" ] && kill "$node_pid" 2>/dev/null || true
  [ -n "$socat_pid" ] && kill "$socat_pid" 2>/dev/null || true
}
trap cleanup EXIT TERM INT

ENCLAVE_EGRESS_PROXY_PORT="$proxy_port" \
ENCLAVE_EGRESS_ALLOWLIST="$allowlist" \
  node "$repo_root/deploy/nitro/host-egress-proxy.mjs" &
node_pid=$!

# Wait for the proxy to accept connections (a bare GET returns 405 = it is up).
ready=0
for _ in $(seq 1 30); do
  if ! kill -0 "$node_pid" 2>/dev/null; then
    echo "egress proxy exited before becoming ready" >&2
    exit 1
  fi
  if curl -sS --max-time 1 -o /dev/null "http://127.0.0.1:${proxy_port}/" 2>/dev/null; then
    ready=1
    break
  fi
  sleep 0.5
done
if [ "$ready" -ne 1 ]; then
  echo "egress proxy did not become ready on 127.0.0.1:${proxy_port}" >&2
  exit 1
fi

# Expose the proxy to the enclave over vsock. fork+reuseaddr handles concurrency.
socat "VSOCK-LISTEN:${vsock_port},fork,reuseaddr" "TCP-CONNECT:127.0.0.1:${proxy_port}" &
socat_pid=$!

while kill -0 "$node_pid" 2>/dev/null && kill -0 "$socat_pid" 2>/dev/null; do
  sleep 2
done
echo "egress proxy or vsock bridge exited; shutting down" >&2
exit 1
