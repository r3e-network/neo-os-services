#!/usr/bin/env bash
# Shared dotnet environment for morpheus-oracle scripts (adopts the
# neo-abstract-account pattern). nccs (the apphost at ~/.dotnet/tools) only
# probes DOTNET_ROOT and /etc/dotnet/install_location — a Homebrew dotnet at
# /opt/homebrew/bin/dotnet is invisible to it unless DOTNET_ROOT points at the
# Cellar libexec. The contract-build-regressions test's skip probe uses
# `dotnet --info` via PATH, so it does NOT skip without this.
if [ -z "${DOTNET_ROOT:-}" ]; then
  if [ -d "$HOME/.dotnet" ]; then
    export DOTNET_ROOT="$HOME/.dotnet"
  elif [ -d "/opt/homebrew/Cellar/dotnet" ]; then
    # Homebrew: newest installed version's libexec.
    latest="$(ls -1 /opt/homebrew/Cellar/dotnet 2>/dev/null | sort -V | tail -n 1)"
    if [ -n "$latest" ]; then
      export DOTNET_ROOT="/opt/homebrew/Cellar/dotnet/${latest}/libexec"
    fi
  fi
fi
if [ -n "${DOTNET_ROOT:-}" ]; then
  export PATH="${DOTNET_ROOT}:${DOTNET_ROOT}/tools:${PATH}"
fi
