#!/usr/bin/env bash
# Dedicated AL2023 TestNet host. No production credentials or writer units.
set -euo pipefail
umask 027

if [[ "$(uname -m)" != x86_64 ]]; then
  echo 'The measured release currently requires an x86_64 Nitro host.' >&2
  exit 1
fi
if [[ -f /opt/neoos/environment && "$(</opt/neoos/environment)" != testnet ]]; then
  echo 'Refusing to bootstrap a host assigned to another environment.' >&2
  exit 1
fi
if command -v nitro-cli >/dev/null && nitro-cli describe-enclaves | jq -e 'length > 0' >/dev/null; then
  echo 'Refusing to change the allocator while an enclave is running.' >&2
  exit 1
fi

dnf install -y docker aws-nitro-enclaves-cli aws-nitro-enclaves-cli-devel \
  git jq socat tar gzip
install -d -m 0750 /opt/neoos/services/releases /opt/neoos/testnet
printf 'testnet\n' >/opt/neoos/environment
printf -- '---\nmemory_mib: 8192\ncpu_count: 4\n' >/etc/nitro_enclaves/allocator.yaml
systemctl enable --now docker amazon-ssm-agent
systemctl enable nitro-enclaves-allocator.service
systemctl restart nitro-enclaves-allocator.service
nitro-cli --version
docker version --format '{{.Server.Version}}'
printf 'NeoOS TestNet Nitro host prepared; no chain writer started.\n'
