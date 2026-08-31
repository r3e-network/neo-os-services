#!/bin/sh
# Morpheus custody enclave entrypoint: the Rust signer_service binary and its
# two socat bridges, nothing else.
#
# The custody service is a LONG-LIVED process (persistent vault state, the
# provision gate, the audit trail), so like entrypoint-enclave.sh we run it
# once bound to loopback and front it with a vsock-LISTEN socat that forwards
# each enclave connection to that local server. The host reaches the custody
# API over vsock:8787; inside, traffic is forwarded to 127.0.0.1:8081.
#
# There is no Node and no second service in here. The image bakes
# SIGNER_SERVICE_ATTESTED_BOOT=require, so the process itself proves its boot
# against the NSM (fresh-nonce attestation, fails closed on the host) and
# starts with the vault sealed; /provision releases the master key later.
set -eu

# A Nitro enclave boots with the loopback interface DOWN. The signer binds
# 127.0.0.1 and both socat bridges use 127.0.0.1, so bring lo UP first or
# every localhost connection (incl. the readiness probe) fails even though
# bind() succeeded.
echo "entrypoint: bringing up loopback"
ip link set dev lo up || echo "entrypoint: WARN could not bring up lo" >&2

# Public vsock port the host's socat TCP-LISTEN:8787 -> VSOCK-CONNECT bridges to.
VSOCK_PORT="${NITRO_SIGNER_VSOCK_PORT:-8787}"
# Internal localhost port the signer binds to (never exposed over vsock).
INTERNAL_HOST="127.0.0.1"
INTERNAL_PORT="${SIGNER_SERVICE_PORT:-8081}"

# --- Outbound egress (in-enclave forward proxy over vsock) ------------------
# The enclave has NO NIC. The only outbound call custody makes is the KMS
# Decrypt during /provision (releasing the transport token and master key
# envelopes), sent by nitro-attest's reqwest client. HTTPS_PROXY points that
# client at a local socat forwarding 127.0.0.1:ENCLAVE_PROXY_PORT to the
# PARENT instance (vsock CID 3), where an allow-listed HTTP-CONNECT proxy
# dials out. The enclave performs END-TO-END TLS to kms.<region>.amazonaws.com
# through the tunnel, so the host forwards opaque ciphertext and CANNOT MITM.
# reqwest's default client reads these variables; loopback is excluded via
# NO_PROXY so the proxy's own transport does not loop through itself.
HOST_CID="${ENCLAVE_HOST_CID:-3}"
EGRESS_VSOCK_PORT="${ENCLAVE_EGRESS_VSOCK_PORT:-8788}"
ENCLAVE_PROXY_PORT="${ENCLAVE_PROXY_PORT:-3128}"
PROXY_URL="http://127.0.0.1:${ENCLAVE_PROXY_PORT}"
export HTTPS_PROXY="$PROXY_URL" HTTP_PROXY="$PROXY_URL"
export https_proxy="$PROXY_URL" http_proxy="$PROXY_URL"
export NO_PROXY="127.0.0.1,localhost,::1" no_proxy="127.0.0.1,localhost,::1"

# Reap children on signals so the enclave shuts down cleanly.
signer_pid=""
socat_pid=""
egress_pid=""
shutdown() {
  [ -n "$socat_pid" ] && kill "$socat_pid" 2>/dev/null || true
  [ -n "$egress_pid" ] && kill "$egress_pid" 2>/dev/null || true
  [ -n "$signer_pid" ] && kill "$signer_pid" 2>/dev/null || true
}
trap shutdown TERM INT

# Outbound bridge: the HTTPS_PROXY target (127.0.0.1:ENCLAVE_PROXY_PORT) -> the
# parent's vsock egress port. fork+reuseaddr handles concurrent outbound conns.
echo "entrypoint: starting egress bridge 127.0.0.1:${ENCLAVE_PROXY_PORT} -> vsock ${HOST_CID}:${EGRESS_VSOCK_PORT}"
socat \
  "TCP-LISTEN:${ENCLAVE_PROXY_PORT},fork,reuseaddr,bind=127.0.0.1" \
  "VSOCK-CONNECT:${HOST_CID}:${EGRESS_VSOCK_PORT}" &
egress_pid=$!

# Start the custody service. In this image attested boot is mandatory, so a
# start outside an enclave dies here — which is the guard working.
echo "entrypoint: starting signer_service on ${INTERNAL_HOST}:${INTERNAL_PORT} (attested boot)"
/app/bin/signer_service serve &
signer_pid=$!

# Wait for the service to accept connections before exposing it over vsock,
# so the first inbound request never races the listener coming up. The probe
# uses socat (already running, tiny), not another process spawn.
echo "entrypoint: waiting for signer_service on ${INTERNAL_HOST}:${INTERNAL_PORT}"
ready=0
i=0
while [ "$i" -lt 120 ]; do
  if [ ! -d "/proc/$signer_pid" ]; then
    echo "signer_service exited before becoming ready" >&2
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
  echo "signer_service did not become ready on ${INTERNAL_HOST}:${INTERNAL_PORT}" >&2
  shutdown
  exit 1
fi
echo "entrypoint: signer_service ready; exposing over vsock :${VSOCK_PORT}"

# Bridge vsock -> the local signer. fork+reuseaddr handles concurrent reqs.
socat \
  "VSOCK-LISTEN:${VSOCK_PORT},fork,reuseaddr" \
  "TCP-CONNECT:${INTERNAL_HOST}:${INTERNAL_PORT}" &
socat_pid=$!

# Fail-stop: if any of the three processes dies, tear the whole enclave down.
# POSIX `sh` (dash) has no `wait -n`, so poll the pids and exit when one drops.
# (The egress listener persists even with no traffic — socat TCP-LISTEN,fork
# keeps the parent listener alive — so its death signals a real fault.)
while [ -d "/proc/$signer_pid" ] && [ -d "/proc/$socat_pid" ] && [ -d "/proc/$egress_pid" ]; do
  sleep 1
done
echo "signer_service, vsock bridge, or egress bridge exited; shutting down" >&2
shutdown
wait 2>/dev/null || true
exit 1
