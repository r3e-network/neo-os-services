#!/bin/sh
# Morpheus Oracle Nitro enclave entrypoint — the SPLIT runtime.
#
# The enclave runs two processes behind the vsock front door:
#   * /app/bin/enclave_host — the Rust trusted frontier (workers/
#     nitro-enclave-host): auth, /provision's KMS state machine,
#     /attestation, and the /oracle/fulfill fold (compute via loopback,
#     signature folded in from custody). It listens on the internal localhost
#     port and SUPERVISES the compute child itself —
#   * the keyless Node compute child (node /app/workers/nitro-worker/src/
#     server.js on ENCLAVE_WORKER_PORT) serves the worker handler's compute
#     lanes with a stripped env and no signing keys. The host spawns it with
#     the overlay env, respawns it when /provision applies new env (the
#     child's config surface is its boot env) and on crash (child.rs watch
#     loop) — so this entrypoint watches ONE server pid, not two.
#
# Rollback: ENCLAVE_RUNTIME=node-merged runs the pre-split merged Node server
# (deploy/nitro/enclave-server.mjs) — the Phase-3 cutover artifact, one
# process doing both jobs. Everything below (egress bridge, readiness probe,
# vsock bridge, fail-stop) is identical for both runtimes: they listen on the
# same internal port.
#
# Listener model (unchanged from the Phase-3 entrypoint): the runtime binds a
# localhost TCP port and a vsock-LISTEN socat fork forwards each enclave
# connection to it. The design (§4): the relayer / feed-pusher reach the
# enclave over vsock:8787; inside, traffic is forwarded to the internal port.
set -eu

# A Nitro enclave boots with the loopback interface DOWN. The internal server
# binds 127.0.0.1 and the inbound/egress socat bridges all use 127.0.0.1, so
# bring lo UP first or every localhost connection (incl. the readiness probe)
# fails even though bind() succeeds.
echo "entrypoint: bringing up loopback"
ip link set dev lo up || echo "entrypoint: WARN could not bring up lo" >&2

# Public vsock port the host's socat TCP-LISTEN:8787 -> VSOCK-CONNECT bridges to.
VSOCK_PORT="${NITRO_SIGNER_VSOCK_PORT:-8787}"
# Internal localhost port the runtime binds to (never exposed over vsock).
INTERNAL_PORT="${ENCLAVE_INTERNAL_PORT:-8081}"
INTERNAL_HOST="127.0.0.1"

# --- Outbound egress (in-enclave forward proxy over vsock) ------------------
# The enclave has NO NIC. In-enclave COMPUTE (the child's price/RPC fetches via
# Node global fetch + neon-js's cross-fetch) reaches the internet through an
# HTTPS_PROXY: a local socat forwards 127.0.0.1:ENCLAVE_PROXY_PORT to the PARENT
# instance (vsock CID 3), where an allow-listed HTTP-CONNECT proxy dials out. The
# enclave performs END-TO-END TLS to the real hostname through the tunnel, so the
# host forwards opaque ciphertext and CANNOT MITM. NODE_USE_ENV_PROXY=1 makes Node
# 22's global fetch (and neon-js via cross-fetch) honor HTTPS_PROXY. The entrypoint
# exports these into its own env: the host inherits them, and the compute child
# inherits them from the host's overlay snapshot (child.rs build_child_env). A
# signing-only request makes no outbound call, so the flag-OFF cutover stage works
# even before the host egress proxy is up; egress is exercised only once compute
# runs in the enclave.
HOST_CID="${ENCLAVE_HOST_CID:-3}"
EGRESS_VSOCK_PORT="${ENCLAVE_EGRESS_VSOCK_PORT:-8788}"
ENCLAVE_PROXY_PORT="${ENCLAVE_PROXY_PORT:-3128}"
PROXY_URL="http://127.0.0.1:${ENCLAVE_PROXY_PORT}"
export NODE_USE_ENV_PROXY=1
export HTTPS_PROXY="$PROXY_URL" HTTP_PROXY="$PROXY_URL"
export https_proxy="$PROXY_URL" http_proxy="$PROXY_URL"
export NO_PROXY="127.0.0.1,localhost,::1" no_proxy="127.0.0.1,localhost,::1"

# Reap children on signals so the enclave shuts down cleanly.
server_pid=""
socat_pid=""
egress_pid=""
shutdown() {
  [ -n "$socat_pid" ] && kill "$socat_pid" 2>/dev/null || true
  [ -n "$egress_pid" ] && kill "$egress_pid" 2>/dev/null || true
  [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null || true
}
trap shutdown TERM INT

# Outbound bridge: the HTTPS_PROXY target (127.0.0.1:ENCLAVE_PROXY_PORT) -> the
# parent's vsock egress port. fork+reuseaddr handles concurrent outbound conns.
echo "entrypoint: starting egress bridge 127.0.0.1:${ENCLAVE_PROXY_PORT} -> vsock ${HOST_CID}:${EGRESS_VSOCK_PORT}"
socat \
  "TCP-LISTEN:${ENCLAVE_PROXY_PORT},fork,reuseaddr,bind=127.0.0.1" \
  "VSOCK-CONNECT:${HOST_CID}:${EGRESS_VSOCK_PORT}" &
egress_pid=$!

# Start the runtime bound to localhost only. The Rust host additionally spawns
# and supervises the keyless compute child (ENCLAVE_WORKER_PORT, default 8090).
ENCLAVE_RUNTIME="${ENCLAVE_RUNTIME:-rust}"
if [ "$ENCLAVE_RUNTIME" = "node-merged" ]; then
  echo "entrypoint: ENCLAVE_RUNTIME=node-merged — starting the pre-split merged Node server (rollback path)"
  ENCLAVE_HOST="$INTERNAL_HOST" \
  PORT="$INTERNAL_PORT" \
  ENCLAVE_PORT="$INTERNAL_PORT" \
    node /app/deploy/nitro/enclave-server.mjs &
  server_pid=$!
else
  echo "entrypoint: starting the Rust enclave host (which supervises the keyless compute child on ${ENCLAVE_WORKER_PORT:-8090})"
  ENCLAVE_HOST="$INTERNAL_HOST" \
  PORT="$INTERNAL_PORT" \
    /app/bin/enclave_host &
  server_pid=$!
fi

# Wait for the internal server to accept connections before exposing it over
# vsock, so the first inbound request never races the listener coming up. The
# probe uses socat (already running, tiny) — NOT `node -e`: the runtime's heap
# sits near the enclave memory cap, so forking a second node for each probe
# iteration OOMs and the readiness check never passes even though the server
# is up. (In the split the host binds its listener before the vsock door
# opens; the compute child may still be warming up — early compute forwards
# fail soft until the host's child watch confirms it.)
echo "entrypoint: waiting for the runtime on ${INTERNAL_HOST}:${INTERNAL_PORT}"
ready=0
i=0
while [ "$i" -lt 120 ]; do
  if [ ! -d "/proc/$server_pid" ]; then
    echo "the runtime exited before becoming ready" >&2
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
  echo "the runtime did not become ready on ${INTERNAL_HOST}:${INTERNAL_PORT}" >&2
  shutdown
  exit 1
fi
echo "entrypoint: runtime ready; exposing over vsock :${VSOCK_PORT}"

# Bridge vsock -> the internal server. fork+reuseaddr handles concurrent reqs.
socat \
  "VSOCK-LISTEN:${VSOCK_PORT},fork,reuseaddr" \
  "TCP-CONNECT:${INTERNAL_HOST}:${INTERNAL_PORT}" &
socat_pid=$!

# Fail-stop: if the runtime or either bridge dies, tear the whole enclave
# down. POSIX `sh` (dash) has no `wait -n`, so poll the pids and exit when one
# drops. (The compute child is deliberately NOT in this list: the HOST
# supervises it — a child crash is a respawn, not an enclave teardown. The
# egress listener persists even with no traffic — socat TCP-LISTEN,fork keeps
# the parent listener alive — so its death signals a real fault, not idleness.)
while [ -d "/proc/$server_pid" ] && [ -d "/proc/$socat_pid" ] && [ -d "/proc/$egress_pid" ]; do
  sleep 1
done
echo "runtime, vsock bridge, or egress bridge exited; shutting down" >&2
shutdown
wait 2>/dev/null || true
exit 1
