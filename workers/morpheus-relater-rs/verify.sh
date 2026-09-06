#!/bin/bash
# Verification script for Morpheus Relayer Rust Migration
# Run this to verify all components are present

set -e

echo "=========================================="
echo "Morpheus Relayer Rust - Verification"
echo "=========================================="
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

count=0
pass=0
fail=0

check() {
    count=$((count + 1))
    if [ $1 -eq 0 ]; then
        echo -e "${GREEN}✓${NC} $2"
        pass=$((pass + 1))
    else
        echo -e "${RED}✗${NC} $2"
        fail=$((fail + 1))
    fi
}

echo "1. Checking Source Files..."
test -f src/config.rs && check 0 "config.rs" || check 1 "config.rs"
test -f src/lib.rs && check 0 "lib.rs" || check 1 "lib.rs"
test -f src/main.rs && check 0 "main.rs" || check 1 "main.rs"
test -f src/types.rs && check 0 "types.rs" || check 1 "types.rs"
test -f src/state_machine.rs && check 0 "state_machine.rs" || check 1 "state_machine.rs"
test -f src/persistence.rs && check 0 "persistence.rs" || check 1 "persistence.rs"
test -f src/retry.rs && check 0 "retry.rs" || check 1 "retry.rs"
test -f src/handlers/mod.rs && check 0 "handlers/mod.rs" || check 1 "handlers/mod.rs"
test -f src/handlers/request.rs && check 0 "handlers/request.rs" || check 1 "handlers/request.rs"
test -f src/handlers/response.rs && check 0 "handlers/response.rs" || check 1 "handlers/response.rs"
test -f src/oracle/client.rs && check 0 "oracle/client.rs" || check 1 "oracle/client.rs"
test -f src/oracle/contract.rs && check 0 "oracle/contract.rs" || check 1 "oracle/contract.rs"
test -f src/oracle/events.rs && check 0 "oracle/events.rs" || check 1 "oracle/events.rs"

echo ""
echo "2. Checking Tests..."
test -f tests/integration.rs && check 0 "integration.rs" || check 1 "integration.rs"
test -f tests/fuzz.rs && check 0 "fuzz.rs" || check 1 "fuzz.rs"

echo ""
echo "3. Checking Documentation..."
test -f README.md && check 0 "README.md" || check 1 "README.md"
test -f DEPLOYMENT_GUIDE.md && check 0 "DEPLOYMENT_GUIDE.md" || check 1 "DEPLOYMENT_GUIDE.md"
test -f PERFORMANCE_COMPARISON.md && check 0 "PERFORMANCE_COMPARISON.md" || check 1 "PERFORMANCE_COMPARISON.md"
test -f PROJECT_SUMMARY.md && check 0 "PROJECT_SUMMARY.md" || check 1 "PROJECT_SUMMARY.md"

echo ""
echo "4. Checking Configuration..."
test -f Cargo.toml && check 0 "Cargo.toml" || check 1 "Cargo.toml"
test -f .env.example && check 0 ".env.example" || check 1 ".env.example"

echo ""
echo "5. Checking Workspace Structure..."
test -f crates/tee-attestation/Cargo.toml && check 0 "tee-attestation crate" || check 1 "tee-attestation crate"
test -f crates/tee-attestation/src/lib.rs && check 0 "tee-attestation lib.rs" || check 1 "tee-attestation lib.rs"

echo ""
echo "6. Checking Binary Compilation..."
if cargo build --release 2>&1 | grep -q "Finished"; then
    echo -e "${GREEN}✓${NC} Binary compiles successfully"
    pass=$((pass + 1))
else
    echo -e "${RED}✗${NC} Binary compilation failed"
    fail=$((fail + 1))
fi

echo ""
echo "=========================================="
echo "Summary: $pass/$count checks passed"
echo "=========================================="

if [ $fail -eq 0 ]; then
    echo -e "${GREEN}All checks passed! ✅${NC}"
    exit 0
else
    echo -e "${RED}$fail checks failed ❌${NC}"
    echo "Please review the failures above."
    exit 1
fi
