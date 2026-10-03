#!/usr/bin/env bash
# Legacy entry point intentionally disabled.
#
# NeoOS now uses one approved Nitro host with separately supervised mainnet and
# TestNet profiles. This historical script would provision a second host and
# must never perform host mutation. Use the single-host runbook instead:
# docs/runbooks/NITRO-SINGLE-HOST-DUAL-NETWORK-20261003.md
set -euo pipefail

printf '%s\n' \
  'Refusing legacy dedicated-TestNet-host bootstrap: the approved topology is one Nitro host with isolated profiles.' \
  'Follow docs/runbooks/NITRO-SINGLE-HOST-DUAL-NETWORK-20261003.md.' >&2
exit 78
