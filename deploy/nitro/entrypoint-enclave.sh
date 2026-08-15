#!/bin/sh
# Morpheus Oracle merged compute+sign enclave entrypoint.
#
# Supersedes entrypoint-signer.sh's one-shot stdio model. The merged server
# (deploy/nitro/enclave-server.mjs) is a LONG-LIVED http.createServer (it reuses
# the worker's persistent listener model), so we run it once bound to a localhost
# TCP port and front it with a vsock-LISTEN socat fork that forwards each enclave
# connection to that local server. This matches the design (§4): the relayer /
# feed-pusher reach the enclave over vsock:8787; inside, traffic is forwarded to
# the Node server on 127.0.0.1.
#
# Contrast with entrypoint-signer.sh, which did
#   socat VSOCK-LISTEN ... EXEC:node nitro-signer-server.mjs --stdio
# spawning a fresh one-shot stdio handler per connection. The worker `handler`
# the merged server reuses keeps in-process state (overload guard, feed cache,
# circuit breakers, provider config), so it MUST be a single persistent process,
# not respawned per request.
set -eu

# A Nitro enclave boots with the loopback interface DOWN. The node server binds
# 127.0.0.1 and the inbound/egress socat bridges all use 127.0.0.1, so bring lo UP
# first or every localhost connection (incl. the readiness probe) fails even
# though bind() succeeds. (The old stdio signer entrypoint never needed loopback.)
echo "entrypoint: bringing up loopback"
ip link set dev lo up || echo "entrypoint: WARN could not bring up lo" >&2

# Public vsock port the host's socat TCP-LISTEN:8787 -> VSOCK-CONNECT bridges to.
VSOCK_PORT="${NITRO_SIGNER_VSOCK_PORT:-8787}"
# Internal localhost port the Node server binds to (never exposed over vsock).
INTERNAL_PORT="${ENCLAVE_INTERNAL_PORT:-8081}"
INTERNAL_HOST="127.0.0.1"

# --- Outbound egress (in-enclave forward proxy over vsock) ------------------
# The enclave has NO NIC. In-enclave COMPUTE (the worker's price/RPC fetches via
# Node global fetch + neon-js's cross-fetch) reaches the internet through an
# HTTPS_PROXY: a local socat forwards 127.0.0.1:ENCLAVE_PROXY_PORT to the PARENT
# instance (vsock CID 3), where an allow-listed HTTP-CONNECT proxy dials out. The
# enclave performs END-TO-END TLS to the real hostname through the tunnel, so the
# host forwards opaque ciphertext and CANNOT MITM. NODE_USE_ENV_PROXY=1 makes Node
# 22's global fetch (and neon-js via cross-fetch) honor HTTPS_PROXY. A signing-only
# request makes no outbound call, so the flag-OFF cutover stage works even before
# the host egress proxy is up; egress is exercised only once compute runs here.
HOST_CID="${ENCLAVE_HOST_CID:-3}"
EGRESS_VSOCK_PORT="${ENCLAVE_EGRESS_VSOCK_PORT:-8788}"
ENCLAVE_PROXY_PORT="${ENCLAVE_PROXY_PORT:-3128}"
PROXY_URL="http://127.0.0.1:${ENCLAVE_PROXY_PORT}"
export NODE_USE_ENV_PROXY=1
export HTTPS_PROXY="$PROXY_URL" HTTP_PROXY="$PROXY_URL"
export https_proxy="$PROXY_URL" http_proxy="$PROXY_URL"
export NO_PROXY="127.0.0.1,localhost,::1" no_proxy="127.0.0.1,localhost,::1"

# Reap children on signals so the enclave shuts down cleanly.
node_pid=""
socat_pid=""
egress_pid=""
shutdown() {
  [ -n "$socat_pid" ] && kill "$socat_pid" 2>/dev/null || true
  [ -n "$egress_pid" ] && kill "$egress_pid" 2>/dev/null || true
  [ -n "$node_pid" ] && kill "$node_pid" 2>/dev/null || true
}
trap shutdown TERM INT

# Outbound bridge: the HTTPS_PROXY target (127.0.0.1:ENCLAVE_PROXY_PORT) -> the
# parent's vsock egress port. fork+reuseaddr handles concurrent outbound conns.
echo "entrypoint: starting egress bridge 127.0.0.1:${ENCLAVE_PROXY_PORT} -> vsock ${HOST_CID}:${EGRESS_VSOCK_PORT}"
socat \
  "TCP-LISTEN:${ENCLAVE_PROXY_PORT},fork,reuseaddr,bind=127.0.0.1" \
  "VSOCK-CONNECT:${HOST_CID}:${EGRESS_VSOCK_PORT}" &
egress_pid=$!

# Start the merged compute+sign server (long-lived) bound to localhost only.
ENCLAVE_HOST="$INTERNAL_HOST" \
PORT="$INTERNAL_PORT" \
ENCLAVE_PORT="$INTERNAL_PORT" \
  node /app/deploy/nitro/enclave-server.mjs &
node_pid=$!

# Wait for the local server to accept connections before exposing it over vsock,
# so the first inbound request never races the listener coming up. The probe uses
# socat (already running, tiny) — NOT `node -e`: the merged server's heap sits near
# the enclave memory cap, so forking a second node for each probe iteration OOMs
# and the readiness check never passes even though the server is up.
echo "entrypoint: waiting for enclave-server on ${INTERNAL_HOST}:${INTERNAL_PORT}"
ready=0
i=0
while [ "$i" -lt 120 ]; do
  if [ ! -d "/proc/$node_pid" ]; then
    echo "enclave-server exited before becoming ready" >&2
    exit 1
  fi
  if socat -T2 /dev/null "TCP:${INTERNAL_HOST}:${INTERNAL_PORT},connect-timeout=2" 2>/dev/null; then
    ready=1
    break
  fi
  i=$((i + 1))
  sleep 0.5
done
if [ "$ready" -ne 1 ]; then
  echo "enclave-server did not become ready on ${INTERNAL_HOST}:${INTERNAL_PORT}" >&2
  shutdown
  exit 1
fi
echo "entrypoint: enclave-server ready; exposing over vsock :${VSOCK_PORT}"

# Bridge vsock -> the local Node server. fork+reuseaddr handles concurrent reqs.
socat \
  "VSOCK-LISTEN:${VSOCK_PORT},fork,reuseaddr" \
  "TCP-CONNECT:${INTERNAL_HOST}:${INTERNAL_PORT}" &
socat_pid=$!

# Fail-stop: if any of the three processes dies, tear the whole enclave down.
# POSIX `sh` (dash) has no `wait -n`, so poll the pids and exit when one drops.
# (The egress listener persists even with no traffic — socat TCP-LISTEN,fork keeps
# the parent listener alive — so its death signals a real fault, not idleness.)
while [ -d "/proc/$node_pid" ] && [ -d "/proc/$socat_pid" ] && [ -d "/proc/$egress_pid" ]; do
  sleep 1
done
echo "enclave-server, vsock bridge, or egress bridge exited; shutting down" >&2
shutdown
wait 2>/dev/null || true
exit 1
