#!/bin/sh
set -eu

VSOCK_PORT="${NITRO_SIGNER_VSOCK_PORT:-8787}"

exec socat \
  "VSOCK-LISTEN:${VSOCK_PORT},fork,reuseaddr" \
  "EXEC:node /app/deploy/nitro/nitro-signer-server.mjs --stdio"
