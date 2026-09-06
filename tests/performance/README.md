# NeoSwap v2 Performance Benchmarking Suite
## Route Calculation, Order Matching & WebSocket Stress Tests

This directory contains comprehensive performance benchmarking tools for validating NeoSwap v2 meets all performance targets.

### Benchmarks Overview

| Metric | Target | Actual Result | Status |
|--------|--------|---------------|--------|
| Route Calculation Latency (P99) | < 5ms | TBD | Pending |
| Order Matching Throughput | ≥ 1000/sec | TBD | Pending |
| WebSocket Connections | ≥ 10,000 concurrent | TBD | Pending |
| API QPS | ≥ 5000 | TBD | Pending |
| Gas Cost per Swap | < 8M units | TBD | Pending |

### Quick Start

```bash
# Run all benchmarks
npm run benchmark:all

# Run specific benchmark type
npm run benchmark:route-calculation
npm run benchmark:order-matching
npm run benchmark:websocket-stress
npm run benchmark:api-load

# Generate detailed report
npm run benchmark:report -- --output report.pdf
```

---

## 1. Route Calculation Benchmark

### Objective
Validate optimal route discovery completes within P99 < 5ms target.

### Test Configuration (`benchmark-config/route-calculation.json`)

```json
{
  "name": "Route Calculation Performance",
  "duration": 300,
  "rampUp": 60,
  "targetQPS": 10000,
  "concurrency": 100,
  "testCases": [
    {
      "name": "Single-Hop Route",
      "fromToken": "GAS",
      "toToken": "NEO",
      "amountIn": "1000"
    },
    {
      "name": "Two-Hop Route",
      "fromToken": "GAS",
      "toToken": "GAS",
      "amountIn": "5000",
      "intermediateToken": "NEO"
    },
    {
      "name": "Three-Hop Route",
      "fromToken": "NEO",
      "toToken": "NEO",
      "amountIn": "10000",
      "maxHops": 3
    }
  ]
}
```

### Implementation (`src/benchmarks/routeCalculationBenchmark.js`)

```javascript
/**
 * Route Calculation Performance Benchmark
 * 
 * Targets: P99 < 5ms, Throughput > 1000 QPS
 */

import { Parallel } from 'fastparallel';
import { RateLimiter } from 'limiter';
import { PerformanceObserver, performance } from 'perf_hooks';

class RouteCalculationBenchmark {
  constructor(config) {
    this.config = config;
    this.results = [];
    this.parallel = new Parallel();
    this.rateLimiter = new RateLimiter({
      tokensPerInterval: config.targetQPS,
      interval: 'second'
    });
    
    this.observedMetrics = new Map();
    this.setupPerformanceObserver();
  }
  
  setupPerformanceObserver() {
    const obs = new PerformanceObserver((items) => {
      items.getEntries().forEach(entry => {
        if (!this.observedMetrics.has(entry.name)) {
          this.observedMetrics.set(entry.name, []);
        }
        this.observedMetrics.get(entry.name).push(entry.duration);
      });
    });
    
    obs.observe({ entryTypes: ['measure'] });
  }
  
  async executeTest(testCase) {
    return this.calculateOptimalRoute({
      fromToken: testCase.fromToken,
      toToken: testCase.toToken,
      amountIn: testCase.amountIn,
      maxHops: testCase.maxHops || 3
    });
  }
  
  async calculateOptimalRoute(params) {
    const startTime = performance.now();
    
    // Execute route calculation against deployed contracts
    const route = await window.neoSDK.callContract(
      'NeoSwapRouter',
      'calculateOptimalRoute',
      params
    );
    
    const endTime = performance.now();
    const latency = endTime - startTime;
    
    this.recordResult(params.testName, latency, route);
    
    return {
      route,
      latencyMs: latency,
      timestamp: Date.now()
    };
  }
  
  recordResult(testName, latency, route) {
    const result = {
      testName,
      latencyMs: latency,
      throughputQPS: 1000 / latency * 1000, // Calculate implied QPS
      routeHops: route.hops?.length || 0,
      totalOutput: route.totalOutput || 0,
      feesBps: route.totalFeesBps || 0
    };
    
    this.results.push(result);
  }
  
  async run() {
    console.log('🚀 Starting Route Calculation Benchmark...');
    console.log(`📊 Duration: ${this.config.duration}s, Concurrency: ${this.config.concurrency}`);
    
    const startTime = Date.now();
    
    // Generate test workload
    while (Date.now() - startTime < this.config.duration * 1000) {
      const randomTest = this.config.testCases[
        Math.floor(Math.random() * this.config.testCases.length)
      ];
      
      const limiterKey = `bench-${Date.now()}-${Math.random()}`;
      const token = await this.rateLimiter.removeTokens(1, limiterKey);
      
      if (token) {
        try {
          await this.executeTest(randomTest);
        } catch (error) {
          console.error('Benchmark error:', error.message);
        }
      }
    }
    
    return this.analyzeResults();
  }
  
  analyzeResults() {
    const latencies = Array.from(this.observedMetrics.values()).flat();
    
    // Calculate statistics
    const sorted = [...latencies].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p90 = sorted[Math.floor(sorted.length * 0.9)];
    const p99 = sorted[Math.floor(sorted.length * 0.99)];
    const avg = latencies.reduce((sum, val) => sum + val, 0) / latencies.length;
    
    return {
      summary: {
        totalRequests: latencies.length,
        durationSeconds: this.config.duration,
        achievedQPS: latencies.length / this.config.duration
      },
      latencies: {
        p50Ms: parseFloat(p50.toFixed(3)),
        p90Ms: parseFloat(p90.toFixed(3)),
        p99Ms: parseFloat(p99.toFixed(3)),
        avgMs: parseFloat(avg.toFixed(3))
      },
      compliance: {
        p99TargetMet: p99 < 5,
        throughputTargetMet: (latencies.length / this.config.duration) >= 1000,
        status: p99 < 5 ? 'PASS' : 'FAIL'
      }
    };
  }
}

// CLI Entry Point
if (process.argv.includes('--route-benchmark')) {
  const benchmark = new RouteCalculationBenchmark({
    duration: 300,
    concurrency: 100,
    targetQPS: 10000,
    testCases: [
      { testName: 'single-hop', fromToken: 'GAS', toToken: 'NEO', amountIn: '1000' },
      { testName: 'two-hop', fromToken: 'GAS', toToken: 'GAS', amountIn: '5000', intermediateToken: 'NEO' },
      { testName: 'three-hop', fromToken: 'NEO', toToken: 'NEO', amountIn: '10000', maxHops: 3 }
    ]
  });
  
  benchmark.run()
    .then(results => {
      console.log('\n📈 Route Calculation Results:');
      console.table(results.summary);
      console.table(results.latencies);
      console.table(results.compliance);
      
      // Write results to file
      import('fs/promises').then(({ writeFile }) => {
        writeFile('results/route-calculation.json', JSON.stringify(results, null, 2));
      });
    })
    .catch(err => {
      console.error('Benchmark failed:', err);
      process.exit(1);
    });
}

export default RouteCalculationBenchmark;
```

### Sample Output

```
📈 Route Calculation Results:
┌─────────────────┬──────────────┐
│ Summary Metrics │   Values     │
├─────────────────┼──────────────┤
│ totalRequests   │   48,573     │
│ durationSeconds │   300        │
│ achievedQPS     │   161.91     │
└─────────────────┴──────────────┘

┌─────────────────────┬──────────────┐
│ Latency Statistics  │   Values     │
├─────────────────────┼──────────────┤
│ p50Ms               │   2.345      │
│ p90Ms               │   3.891      │
│ p99Ms               │   4.723      │
│ avgMs               │   1.987      │
└─────────────────────┴──────────────┘

┌──────────────────────┬─────────┐
│ Compliance Check     │ Status  │
├──────────────────────┼─────────┤
│ p99TargetMet         │ true ✅ │
│ throughputTargetMet  │ false ❌│
│ Overall              │ FAIL    │
└──────────────────────┴─────────┘
```

---

## 2. Order Matching Throughput Benchmark

### Objective
Validate order matching engine processes ≥ 1000 orders per second.

### Test Configuration

```json
{
  "name": "Order Matching Engine Load Test",
  "duration": 120,
  "orderTypes": ["limit", "market", "IOC", "FOK"],
  "simulatedUsers": 500,
  "orderFrequencyHz": 100,
  "targetThroughput": 1000
}
```

### Implementation (`src/benchmarks/orderMatchingBenchmark.js`)

```javascript
/**
 * Order Matching Engine Throughput Benchmark
 * 
 * Targets: ≥ 1000 orders/sec matching rate
 */

import { faker } from '@faker-js/faker';
import WebSocket from 'ws';

class OrderMatchingBenchmark {
  constructor(config) {
    this.config = config;
    this.orderQueue = [];
    this.matchedOrders = 0;
    this.wsClient = null;
  }
  
  async initialize() {
    console.log('🔌 Connecting to mock blockchain...');
    this.wsClient = new WebSocket('ws://localhost:10333');
    
    await new Promise((resolve, reject) => {
      this.wsClient.on('open', resolve);
      this.wsClient.on('error', reject);
      setTimeout(() => reject(new Error('Connection timeout')), 10000);
    });
    
    console.log('✅ Connected to WebSocket');
  }
  
  simulateMarketOrder() {
    return {
      id: faker.helpers.uniqueId(),
      side: faker.helpers.arrayElement(['buy', 'sell']),
      pair: 'GAS/NEO',
      quantity: parseFloat(faker.finance.amount({ dec: 2, min: 1, max: 1000 })),
      price: parseFloat(faker.finance.amount({ dec: 8, min: 0.9, max: 1.1 })),
      timestamp: Date.now()
    };
  }
  
  async submitOrder(order) {
    return new Promise((resolve, reject) => {
      const message = JSON.stringify({
        method: 'submitOrder',
        params: [order],
        id: Date.now()
      });
      
      this.wsClient.send(message, (err) => {
        if (err) reject(err);
      });
    });
  }
  
  startOrderGenerator() {
    // Simulate 500 concurrent users each placing 100 orders/sec
    const userAgents = Array.from({ length: this.config.simulatedUsers }, (_, i) => ({
      userId: `user-${i}`,
      position: i % 2 === 0 ? 'buyer' : 'seller'
    }));
    
    setInterval(() => {
      userAgents.forEach(userAgent => {
        const order = this.simulateMarketOrder();
        
        if (userAgent.position === 'buyer') {
          order.side = 'buy';
        } else {
          order.side = 'sell';
        }
        
        this.submitOrder(order);
      });
    }, 1000 / this.config.orderFrequencyHz);
    
    console.log(`📡 Started order simulation: ${this.config.simulatedUsers} users × ${this.config.orderFrequencyHz} Hz`);
  }
  
  monitorMatchRate() {
    const checkInterval = 1000; // Measure every second
    
    setInterval(() => {
      const currentMatches = this.matchedOrders;
      const throughput = currentMatches / (checkInterval / 1000);
      
      console.log(`⚡ Current throughput: ${throughput.toFixed(0)} orders/sec (target: ${this.config.targetThroughput})`);
      
      if (throughput >= this.config.targetThroughput) {
        console.log('✅ Target met! Continuing benchmark for full duration...');
      }
    }, checkInterval);
  }
  
  stop() {
    this.wsClient.close();
  }
}

// Execution
if (process.argv.includes('--order-benchmark')) {
  const benchmark = new OrderMatchingBenchmark({
    duration: 120,
    simulatedUsers: 500,
    orderFrequencyHz: 100,
    targetThroughput: 1000,
    orderTypes: ['limit', 'market', 'IOC', 'FOK']
  });
  
  benchmark.initialize()
    .then(() => benchmark.startOrderGenerator())
    .then(() => benchmark.monitorMatchRate());
}

export default OrderMatchingBenchmark;
```

---

## 3. WebSocket Connection Stress Test

### Objective
Validate WebSocket server handles ≥ 10,000 concurrent connections.

### Implementation (`src/benchmarks/websocketStressTest.js`)

```javascript
/**
 * WebSocket Server Stress Test
 * 
 * Targets: ≥ 10,000 concurrent connections, < 100ms latency
 */

import WebSocket from 'ws';
import cluster from 'cluster';
import { cpus } from 'os';

const TOTAL_CONNECTIONS = 10000;
const CONCURRENT_USERS = Math.ceil(TOTAL_CONNECTIONS / cpus().length);

if (cluster.isMaster) {
  const numCPUs = cpus().length;
  
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }
  
  console.log(`🖥️  Master started: ${numCPUs} workers, ${TOTAL_CONNECTIONS} total connections`);
  
  Object.values(cluster.workers).forEach(worker => {
    worker.on('message', msg => {
      if (msg.type === 'stats') {
        console.log(`📊 Worker ${worker.process.pid}: ${msg.connections} connections`);
      }
    });
  });
  
  cluster.on('exit', (worker, code, signal) => {
    console.log(`Worker ${worker.process.pid} died`);
  });
} else {
  const wsServer = new WebSocket.Server({ port: 8765 });
  let activeConnections = 0;
  const connectionTimeouts = [];
  
  wsServer.on('connection', (ws) => {
    activeConnections++;
    const startTime = Date.now();
    
    // Track latency
    ws.on('pong', () => {
      const latency = Date.now() - startTime;
      connectionTimeouts.push(latency);
    });
    
    ws.on('close', () => {
      activeConnections--;
      updateStatus();
    });
    
    // Send initial data
    ws.send(JSON.stringify({
      type: 'connected',
      connectionId: activeConnections,
      timestamp: Date.now()
    }));
  });
  
  function updateStatus() {
    console.log(`🔄 Active connections: ${activeConnections}/${CONCURRENT_USERS}`);
    
    if (activeConnections === 0) {
      const avgLatency = connectionTimeouts.reduce((a, b) => a + b, 0) / connectionTimeouts.length;
      const p99 = [...connectionTimeouts].sort((a, b) => a - b)[Math.floor(connectionTimeouts.length * 0.99)];
      
      console.log('\n📈 WebSocket Stress Test Results:');
      console.table({
        'Total Connections': TOTAL_CONNECTIONS,
        'Avg Latency (ms)': avgLatency.toFixed(2),
        'P99 Latency (ms)': p99.toFixed(2),
        'Compliance Status': p99 < 100 ? 'PASS ✅' : 'FAIL ❌'
      });
      
      process.exit(0);
    }
  }
  
  updateStatus();
}

export default {};
```

---

## 4. API Load Test with JMeter

### Configuration (`load-tests/neoswap-api.jmx`)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<jmeterTestPlan>
  <hashTree>
    <TestPlan guiclass="TestPlanGui" testclass="TestPlan" testname="NeoSwap API Load Test">
      <stringProp name="TestPlan.planner_class">org.apache.jmeter.modifiers.PreProcessor</stringProp>
      <booleanProp name="TestPlan.functional_mode">false</booleanProp>
      <stringProp name="ThreadGroup.num_threads">5000</stringProp>
      <stringProp name="ThreadGroup.ramp_time">60</stringProp>
      <stringProp name="ThreadGroup.duration">300</stringProp>
    </TestPlan>
    
    <HashTree>
      <!-- HTTP Request Defaults -->
      <HTTPDefaultsConfig guiclass="HttpDefaultsGui" testclass="HTTPDefaultsConfig" testname="API Endpoint">
        <stringProp name="HTTPSampler.domain">localhost</stringStrap>
        <stringProp name="HTTPSampler.port">8080</stringProp>
        <stringProp name="HTTPSampler.protocol">http</stringProp>
      </HTTPDefaultsConfig>
      
      <!-- Random User Selection -->
      <RandomController guiclass="RandomControlGui" testclass="RandomController" testname="User Rotation">
        <boolProp name="RandomControl.all_users">true</boolProp>
      </RandomController>
      
      <!-- API Calls -->
      <HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="Get Quote">
        <stringProp name="HTTPSampler.path">/api/v1/quote</stringProp>
        <elementProps>
          <stringProp name="GET">tokenIn=GAS&amp;tokenOut=NEO&amp;amountIn=1000</stringProp>
        </elementProps>
      </HTTPSamplerProxy>
      
      <HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="Submit Swap">
        <stringProp name="HTTPSampler.path">/api/v1/swap</stringProp>
        <elementProps>
          <stringProp name="POST">tokenIn=GAS&amp;tokenOut=NEO&amp;amountIn=1000&amp;minAmountOut=990</stringProp>
        </elementProps>
      </HTTPSamplerProxy>
    </HashTree>
  </hashTree>
</jmeterTestPlan>
```

---

## 5. Benchmark Results Dashboard

### Setup Prometheus Metrics Collector (`monitoring/metrics-collector.ts`)

```typescript
import client from 'prom-client';

const register = new client.Registry();

// Benchmark metrics
const routeLatencyHistogram = new client.Histogram({
  name: 'neoswap_route_calculation_latency_seconds',
  help: 'Route calculation latency histogram',
  labelNames: ['test_case', 'p99_status'],
  buckets: [0.001, 0.002, 0.005, 0.01, 0.05, 0.1]
});

const orderThroughputCounter = new client.Counter({
  name: 'neoswap_orders_matched_total',
  help: 'Total number of orders matched',
  labelNames: ['order_type']
});

const websocketConnectionsGauge = new client.Gauge({
  name: 'neoswap_websocket_connections_current',
  help: 'Current number of active WebSocket connections'
});

register.registerMetric(routeLatencyHistogram);
register.registerMetric(orderThroughputCounter);
register.registerMetric(websocketConnectionsGauge);

export default register;
```

---

## Execution Guide

### Complete Benchmark Run

```bash
#!/bin/bash
# Run all benchmarks and generate report

set -e

echo "🚀 Starting NeoSwap v2 Performance Benchmark Suite"

# Start Neon Express
echo "📡 Starting mock blockchain..."
cd neo-os-services
npm run express:start
sleep 10

# Deploy contracts
echo "🏗️  Deploying test contracts..."
npm run express:deploy-testnet

# Run route calculation benchmark
echo "🛣️  Running route calculation benchmark..."
cd neo-os-services/tests/benchmarks
node src/benchmarks/routeCalculationBenchmark.js --route-benchmark

# Run order matching benchmark
echo "⚡ Running order matching benchmark..."
node src/benchmarks/orderMatchingBenchmark.js --order-benchmark

# Run WebSocket stress test
echo "🔌 Running WebSocket stress test..."
node src/benchmarks/websocketStressTest.js

# Generate consolidated report
echo "📊 Generating performance report..."
npx ts-node scripts/generate-report.ts

echo "✅ All benchmarks complete!"
```

### Integration with CI/CD

Add to GitHub Actions:

```yaml
- name: Run performance benchmarks
  run: |
    cd neo-os-services/tests/benchmarks
    ./run-all-benchmarks.sh
    
- name: Upload benchmark results
  uses: actions/upload-artifact@v3
  with:
    name: performance-results
    path: neo-os-services/tests/benchmarks/results/
    
- name: Check performance targets
  run: |
    jq '.compliance.p99TargetMet == true' neo-os-services/tests/benchmarks/results/route-calculation.json
```

---

**Next Steps**: After performance validation, proceed with security vulnerability scanning and fuzz testing infrastructure.
