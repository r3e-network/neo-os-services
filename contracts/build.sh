#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
# nccs apphost needs DOTNET_ROOT on Homebrew installs (see scripts/dotnet_env.sh).
source "$SCRIPT_DIR/../scripts/dotnet_env.sh"
mkdir -p build

echo "=== Building Morpheus Contracts ==="
# Which nccs: $NCCS (an explicit path), else the first nccs on PATH (dotnet_env.sh adds
# $DOTNET_ROOT/tools, CI adds ~/.dotnet/tools), else the default global-tool directory.
if [ -n "${NCCS:-}" ]; then
  NCCS_BIN="$NCCS"
  if [ ! -f "$NCCS_BIN" ] || [ ! -x "$NCCS_BIN" ]; then
    echo "NCCS=$NCCS_BIN is not an executable file" >&2
    exit 1
  fi
elif NCCS_BIN="$(command -v nccs)"; then
  :
elif [ -x "$HOME/.dotnet/tools/nccs" ]; then
  NCCS_BIN="$HOME/.dotnet/tools/nccs"
else
  echo "nccs not found; install Neo.Compiler.CSharp 3.9.1 or set NCCS=/path/to/nccs" >&2
  exit 1
fi
NCCS_VERSION=$("$NCCS_BIN" --version)
echo "Using nccs $NCCS_VERSION ($NCCS_BIN)"
case "$NCCS_VERSION" in
  3.9.1*) ;;
  *)
    echo "nccs 3.9.1 is required; found $NCCS_VERSION" >&2
    exit 1
    ;;
esac

for d in MorpheusOracle MorpheusDataFeed OracleCallbackConsumer; do
  if [ -f "$d/$d.csproj" ]; then
    echo "Building $d..."
    dotnet build "$d/$d.csproj" -c Release
    "$NCCS_BIN" "$d/$d.csproj" --generate-artifacts Source --output ./build/
  fi
done

echo "=== Build Complete ==="
