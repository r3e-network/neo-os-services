#!/bin/bash

# NeoSwap v2 - Test Coverage Runner

echo "========================================"
echo "NeoSwap v2 - Unit Test Coverage"
echo "========================================"

# Run tests for each service
for service in routing-engine order-matcher oracle-aggregator api-gateway price-feed analytics-api; do
  echo ""
  echo "🧪 Running tests for $service..."
  
  if [ -f "services/neoswap/$service/package.json" ]; then
    cd "services/neoswap/$service"
    
    # Check if node_modules exists
    if [ ! -d "node_modules" ]; then
      echo "   Installing dependencies..."
      npm ci --only=production
    fi
    
    # Run tests with coverage
    npm run test 2>/dev/null || {
      echo "   ⚠️  Tests failed or skipped for $service"
      continue
    }
    
    # Check coverage percentage
    if [ -f "coverage/coverage-summary.json" ]; then
      coverage=$(cat coverage/coverage-summary.json | jq -r '.total.pct')
      coverage_int=${coverage%.*}
      
      echo "   📊 Coverage: ${coverage}%"
      
      if [ "$coverage_int" -ge 85 ]; then
        echo "   ✅ Meets 85% threshold"
      else
        echo "   ⚠️  Below 85% threshold (needs improvement)"
      fi
    fi
    
    cd ../../..
  else
    echo "   ❌ Service package.json not found"
  fi
done

echo ""
echo "========================================"
echo "Coverage Summary Complete"
echo "========================================"
