#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
# nccs apphost needs DOTNET_ROOT on Homebrew installs (see scripts/dotnet_env.sh).
source "$SCRIPT_DIR/../scripts/dotnet_env.sh"
mkdir -p build

echo "=== Building Morpheus Contracts ==="
if [ -x ~/.dotnet/tools/nccs ]; then
  NCCS_VERSION=$(~/.dotnet/tools/nccs --version)
  echo "Using nccs $NCCS_VERSION"
  case "$NCCS_VERSION" in
    3.9.1*) ;;
    *)
      echo "nccs 3.9.1 is required; found $NCCS_VERSION" >&2
      exit 1
      ;;
  esac
else
  echo "nccs not found; install Neo.Compiler.CSharp 3.9.1" >&2
  exit 1
fi

for d in MorpheusOracle MorpheusDataFeed OracleCallbackConsumer NeoDIDRegistry; do
  if [ -f "$d/$d.csproj" ]; then
    echo "Building $d..."
    dotnet build "$d/$d.csproj" -c Release
    ~/.dotnet/tools/nccs "$d/$d.csproj" --generate-artifacts Source --output ./build/
  fi
done

echo "=== Build Complete ==="
