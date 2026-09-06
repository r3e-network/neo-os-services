# NeoSwap v2 Mock Blockchain Environment Configuration
## Neon Express Integration & Integration Test Suite

This directory contains configuration and scripts for running NeoSwap v2 integration tests on a mocked blockchain environment using Neon Express.

### Quick Start

```bash
# 1. Start Neon Express node
npm run express:start

# 2. Deploy test contracts
npm run express:deploy-testnet

# 3. Run integration test suite
npm run test:integration

# 4. Stop Neon Express when done
npm run express:stop
```

### Directory Structure

```
tests/integration/
├── neon-express/          # Neon Express configuration and state
├── fixtures/             # Test data fixtures
│   ├── pools.json        # Pre-configured liquidity pools
│   ├── users.json        # Test user accounts
│   └── transactions.json # Sample transaction history
├── scripts/              # Integration test automation
│   ├── deploy-contracts.mjs
│   ├── setup-environment.mjs
│   └── cleanup-test-state.mjs
├── unit/                 # Unit-level integration tests
│   ├── PoolIntegrationTest.cs
│   ├── RouterIntegrationTest.cs
│   └── OracleIntegrationTest.cs
└── e2e/                  # End-to-end integration tests
    ├── CompleteFlow.cy.js
    └── CrossService.cy.js
```

### Neon Express Configuration

#### Default Network Settings (`.express/config.json`)

```json
{
  "network": {
    "magic": 880,
    "port": 10331,
    "address": "127.0.0.1"
  },
  "protocol": {
    "networkIdentifier": 0x33354e4f,
    "standbyValidators": ["03b209b47506c7ac6c605538a8cc7455cf7ef3e242eb2cee5d1cded1c99eaecff6"],
    "consensusAddress": "AJbpYFJkZAjUZFSWUq7RzCKgPL5KmQvPmZ",
    "minGenTime": 1000,
    "maxTraceableBlocks": 1000
  },
  "storage": {
    "directory": "./data",
    "type": "leveldb"
  },
  "plugins": {
    "RPC": {
      "enable": true,
      "port": 10332
    },
    "WebSocket": {
      "enable": true,
      "port": 10333
    }
  }
}
```

#### Test Contract Deployment Manifest (`manifests/testnet-deploy.json`)

```json
{
  "contracts": [
    {
      "name": "NeoSwapRouter",
      "nefPath": "../build/neoswap-v2.nef",
      "manifestPath": "../build/neoswap-v2.manifest.json",
      "adminAccount": "0x0000000000000000000000000000000000000001",
      "initializationParams": {
        "admin": "0x0000000000000000000000000000000000000001",
        "feeBps": 5
      }
    },
    {
      "name": "PlatformDeFi",
      "nefPath": "../build/platform-defi.nef",
      "manifestPath": "../build/platform-defi.manifest.json",
      "adminAccount": "0x0000000000000000000000000000000000000001"
    },
    {
      "name": "MorpheusOracle",
      "nefPath": "../build/morpheus-oracle.nef",
      "manifestPath": "../build/morpheus-oracle.manifest.json",
      "adminAccount": "0x0000000000000000000000000000000000000001"
    }
  ],
  "tokens": [
    {
      "symbol": "NEO",
      "totalSupply": "100000000",
      "decimals": 8
    },
    {
      "symbol": "GAS",
      "totalSupply": "100000000",
      "decimals": 8
    }
  ]
}
```

### Integration Test Scripts

#### 1. Deploy Contracts Script (`scripts/deploy-contracts.mjs`)

```javascript
#!/usr/bin/env node
/**
 * NeoSwap v2 Testnet Deployment Script
 * 
 * Usage: npm run express:deploy-testnet
 */

import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

const EXPRESS_RPC = 'http://localhost:10332';
const EXPRESS_WSS = 'ws://localhost:10333';

async function deployContracts() {
  console.log('🚀 Starting NeoSwap v2 deployment to Neon Express...');
  
  // 1. Check if Express is running
  const isRunning = await checkExpressStatus();
  if (!isRunning) {
    throw new Error('Neon Express is not running. Start it with: npm run express:start');
  }

  // 2. Initialize NeoExpress client
  const neoExpress = await initializeNeoExpressClient(EXPRESS_RPC);
  
  // 3. Read contract artifacts
  const routerNef = await fs.readFile('../build/neoswap-v2.nef');
  const routerManifest = JSON.parse(await fs.readFile('../build/neoswap-v2.manifest.json', 'utf-8'));
  
  // 4. Deploy contracts sequentially
  const deployedContracts = {};
  
  const contractsToDeploy = [
    { name: 'NeoSwapRouter', nef: routerNef, manifest: routerManifest },
    { name: 'PlatformDeFi', nef: await fs.readFile('../build/platform-defi.nef'), ... },
    { name: 'MorpheusOracle', nef: await fs.readFile('../build/morpheus-oracle.nef'), ... }
  ];
  
  for (const contract of contractsToDeploy) {
    console.log(`📦 Deploying ${contract.name}...`);
    
    const txHash = await neoExpress.deployContract({
      nef: contract.nef,
      manifest: contract.manifest,
      senderAddress: '0x0000000000000000000000000000000000000001'
    });
    
    deployedContracts[contract.name] = txHash;
    console.log(`✅ ${contract.name} deployed at hash: ${txHash}`);
    
    // Wait for confirmation
    await waitForTransaction(txHash);
  }
  
  // 5. Store deployment addresses
  const deploymentRecord = {
    timestamp: new Date().toISOString(),
    network: 'Neon Express Testnet',
    rpcUrl: EXPRESS_RPC,
    wsUrl: EXPRESS_WSS,
    contracts: deployedContracts,
    adminAccount: '0x0000000000000000000000000000000000000001'
  };
  
  await fs.writeFile('deployment-record.json', JSON.stringify(deploymentRecord, null, 2));
  console.log('💾 Deployment record saved to deployment-record.json');
  
  return deployedContracts;
}

// Helper functions
async function checkExpressStatus() {
  try {
    const result = await fetch(`${EXPRESS_RPC}/node/version`);
    return result.ok;
  } catch (error) {
    return false;
  }
}

function initializeNeoExpressClient(rpcUrl) {
  // Initialize Neo SDK client
  return window.neoSDK.connect(rpcUrl);
}

async function waitForTransaction(txHash, timeout = 30000) {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    const status = await fetch(`${EXPRESS_RPC}/tx/${txHash}`);
    if (status.status === 200) {
      const txData = await status.json();
      return txData.execution.result === 'HALT';
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  throw new Error(`Transaction ${txHash} timeout after ${timeout}ms`);
}

// CLI entry point
if (process.argv.includes('--deploy')) {
  deployContracts()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('❌ Deployment failed:', err);
      process.exit(1);
    });
}

export default deployContracts;
```

#### 2. Setup Test Environment (`scripts/setup-environment.mjs`)

```javascript
#!/usr/bin/env node
/**
 * NeoSwap v2 Test Environment Setup
 * Creates initial liquidity pools, test users, and market conditions
 */

import { deployContracts } from './deploy-contracts.mjs';

async function setupTestEnvironment() {
  console.log('⚙️  Setting up NeoSwap v2 test environment...');
  
  // Import deployment record
  const deployment = JSON.parse(await fs.readFile('deployment-record.json'));
  const neoExpress = await initializeNeoExpressClient(deployment.rpcUrl);
  
  // 1. Create Initial Liquidity Pools
  console.log('🏊 Creating initial liquidity pools...');
  
  const poolConfigs = [
    {
      tokenA: 'NEO',
      tokenB: 'GAS',
      reserveA: BigInt('1000000000000'),
      reserveB: BigInt('1000000000000')
    },
    {
      tokenA: 'NEO',
      tokenB: 'NEO',
      reserveA: BigInt('500000000000'),
      reserveB: BigInt('500000000000')
    }
  ];
  
  for (const config of poolConfigs) {
    await createPool(deployment.contracts.NeoSwapRouter, config);
  }
  
  // 2. Fund Test Users
  console.log('💰 Funding test user wallets...');
  
  const testUsers = [
    { address: '0xUser001', neo: '10000', gas: '10000' },
    { address: '0xUser002', neo: '5000', gas: '5000' },
    { address: '0xUser003', neo: '1000', gas: '1000' }
  ];
  
  for (const user of testUsers) {
    await fundWallet(user.address, user.neo, user.gas);
  }
  
  // 3. Set Oracle Price Feeds
  console.log('📊 Configuring oracle price feeds...');
  
  await setPriceFeed('NEOGAS', {
    price: 0.99,
    roundId: 1,
    timestamp: Math.floor(Date.now() / 1000),
    confidence: 0.99
  });
  
  await setPriceFeed('NEONEO', {
    price: 1.0,
    roundId: 2,
    timestamp: Math.floor(Date.now() / 1000),
    confidence: 0.99
  });
  
  console.log('✅ Test environment ready!');
  console.log(`📍 RPC URL: ${deployment.rpcUrl}`);
  console.log(`📍 WebSocket URL: ${deployment.wsUrl}`);
  console.log(`💼 Admin Account: ${deployment.adminAccount}`);
  
  return {
    rpcUrl: deployment.rpcUrl,
    wsUrl: deployment.wsUrl,
    contracts: deployment.contracts,
    users: testUsers,
    priceFeeds: ['NEOGAS', 'NEONEO']
  };
}

// Helper functions
async function createPool(routerContract, config) {
  const tx = await routerContract.invoke('createPool', [config.tokenA, config.tokenB]);
  await tx.signAndSend();
}

async function fundWallet(address, neoAmount, gasAmount) {
  // Send tokens to test wallet
  await sendToken('NEO', address, neoAmount);
  await sendToken('GAS', address, gasAmount);
}

async function setPriceFeed(pair, priceData) {
  const oracleContract = /* ... */;
  await oracleContract.invoke('updatePriceFeed', [pair, priceData]);
}

export default setupTestEnvironment;
```

### Integration Test Suites

#### Unit-Level Integration Tests

**`unit/PoolIntegrationTest.cs`** - Liquidity Pool Operations

```csharp
[TestClass]
public class PoolIntegrationTest
{
    private BlockchainTestingFixture<NeoSwapRouter> _fixture;
    
    [TestInitialize]
    public void Setup()
    {
        var expressUrl = Environment.GetEnvironmentVariable("EXPRESS_RPC") ?? "http://localhost:10332";
        _fixture = new BlockchainTestingFixture<NeoSwapRouter>(expressUrl);
        
        // Reset to clean state
        _fixture.ResetBlockchain();
        
        // Deploy test contracts
        _fixture.InvokeTransaction("init", UInt160.Parse("0xAdmin"), 5m);
    }
    
    [TestMethod]
    [TestCategory("Integration")]
    public void POOL_INT_001_CreatePool_ValidatesReserves()
    {
        // Arrange
        var tokenA = NativeContract.GAS.Hash;
        var tokenB = NativeContract.NEO.Hash;
        
        // Act
        var poolAddress = _fixture.CallStatic<UInt160>("createPool", tokenA, tokenB);
        
        // Assert
        Assert.IsNotNull(poolAddress);
        
        var reserves = _fixture.CallStatic<PoolReserves>("getReserves", poolAddress);
        Assert.IsTrue(reserves.reserveA > 0);
        Assert.IsTrue(reserves.reserveB > 0);
        
        // Verify invariant maintained
        var invariant = reserves.reserveA * reserves.reserveB;
        Assert.IsTrue(invariant > 0);
    }
    
    [TestMethod]
    [TestCategory("Integration")]
    public void POOL_INT_002_AddLiquidity_CalculatesLPSharesCorrectly()
    {
        // Arrange
        var amountA = BigInteger.Parse("1000000000");
        var amountB = BigInteger.Parse("1000000000");
        var recipient = UInt160.Parse("0xRecipient");
        
        // Act
        var shares = _fixture.CallStatic<BigInteger>("addLiquidity", 
            amountA, amountB, recipient);
        
        // Assert
        Assert.AreEqual(amountA + amountB, shares);
        
        var balance = _fixture.CallStatic<BigInteger>("balanceOf", recipient, shares);
        Assert.AreEqual(shares, balance);
    }
    
    [TestMethod]
    [TestCategory("Integration")]
    public void POOL_INT_003_Swap_MaintainsConstantProductInvariant()
    {
        // Arrange
        var initialReserveA = BigInteger.Parse("1000000000");
        var initialReserveB = BigInteger.Parse("1000000000");
        var initialInvariant = initialReserveA * initialReserveB;
        
        // Execute swap
        var amountIn = BigInteger.Parse("100000000");
        var path = new[] { NativeContract.GAS.Hash, NativeContract.NEO.Hash };
        
        var output = _fixture.CallStatic<BigInteger>("swapExactInput", 
            amountIn, BigInteger.Zero, path, msg.Sender);
        
        // Verify invariant preserved
        var finalReserves = _fixture.CallStatic<PoolReserves>("getReserves", /* pool address */);
        var finalInvariant = finalReserves.reserveA * finalReserves.reserveB;
        
        Assert.AreEqual(initialInvariant, finalInvariant);
    }
}
```

#### E2E Integration Tests

**`e2e/CompleteFlow.cy.js`** - Full User Journey

```javascript
/// <reference types="cypress" />

describe('NeoSwap v2 Complete Integration Flow', () => {
  beforeEach(() => {
    // Load deployment configuration
    cy.fixture('deployment').then(deployment => {
      Cypress.env('deployment', deployment);
    });
    
    // Connect to mock blockchain
    cy.connectToMockBlockchain(Cypress.env('deployment').rpcUrl);
  });
  
  it('COMPLETE_FLOW_001: Deposit → Swap → Withdraw on Mock Blockchain', () => {
    // Phase 1: Wallet Setup
    cy.createUserWallet().then((wallet) => {
      expect(wallet.address).to.match(/^0x[A-Fa-f0-9]{40}$/);
      expect(wallet.balances).to.have.property('NEO');
      expect(wallet.balances).to.have.property('GAS');
    });
    
    // Phase 2: Liquidity Provision
    cy.addLiquidity({
      tokenA: 'NEO',
      tokenB: 'GAS',
      amountA: '10000',
      amountB: '10000'
    }).then((lpPosition) => {
      expect(lpPosition.poolId).to.be.greaterThan(0);
      expect(lpPosition.shares).to.be.greaterThan(0);
      
      cy.verifyLPBalance(lpPosition.poolId, lpPosition.shares);
    });
    
    // Phase 3: Token Swap (Multi-Hop)
    cy.swapTokens({
      fromToken: 'GAS',
      toToken: 'NEO',
      amountIn: '5000',
      minAmountOut: '4900',
      maxHops: 3,
      slippageProtection: true
    }).then((swapResult) => {
      expect(swapResult.actualOutput).to.be.at.least(4900);
      expect(swapResult.route.hops.length).to.be.at.most(3);
      expect(swapResult.totalFeesBps).to.be.at.most(5);
      
      // Log swap event to blockchain
      cy.verifySwapEventEmitted(swapResult.transactionHash);
    });
    
    // Phase 4: Real-Time Price Update Verification
    cy.subscribeToPriceFeed('NEOGAS').then((subscription) => {
      subscription.on('priceUpdate', (data) => {
        expect(data.price).to.be.greaterThan(0);
        expect(data.timestamp).to.be.within(
          Date.now() - 60000, // Within 1 minute
          Date.now()
        );
      });
      
      // Simulate swap price impact
      cy.executeLargeSwap('20000').then(() => {
        // Verify price update reflects swap
        cy.wait(1000); // Allow propagation
        subscription.getLastUpdate().then((lastPrice) => {
          expect(lastPrice.changePercent).to.be.lessThan(-0.01); // Slight decrease
        });
      });
    });
    
    // Phase 5: Liquidity Withdrawal
    cy.withdrawLiquidity({
      poolId: lpPosition.poolId,
      shares: 'all'
    }).then((withdrawalResult) => {
      expect(withdrawalResult.amountA).to.be.greaterThan(0);
      expect(withdrawalResult.amountB).to.be.greaterThan(0);
      
      // Verify no LP tokens remain
      cy.verifyLPBalance(lpPosition.poolId, 0);
    });
    
    // Final State Verification
    cy.getUserFinalState().then((state) => {
      expect(state.totalSwapsExecuted).to.be.greaterThan(0);
      expect(state.totalVolumeProcessed).to.be.greaterThan(0);
      expect(state.feesPaidTotal).to.be.greaterThan(0);
      expect(state.lpPositionsClosed).to.be.true;
    });
  });
});
```

### CI/CD Pipeline Configuration

#### GitHub Actions Workflow (`.github/workflows/integration-tests.yml`)

```yaml
name: Integration Tests

on:
  push:
    branches: [ main, develop ]
  pull_request:
    branches: [ main, develop ]

env:
  EXPRESS_RPC: http://localhost:10332
  EXPRESS_WS: ws://localhost:10333

jobs:
  integration-tests:
    runs-on: ubuntu-latest
    
    steps:
      - name: Checkout repository
        uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
          cache: 'npm'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Build contracts
        run: |
          cd neo-os-contracts
          npm run build
      
      - name: Start Neon Express
        run: |
          cd neo-os-services
          npx neon-express --config ./.express/config.json &
          sleep 10
          curl -X POST ${{ env.EXPRESS_RPC }}/node/version
        
      - name: Deploy test contracts
        run: |
          cd neo-os-services/tests/integration
          node scripts/deploy-contracts.mjs --deploy
      
      - name: Setup test environment
        run: |
          cd neo-os-services/tests/integration
          node scripts/setup-environment.mjs
      
      - name: Run C# integration tests
        run: |
          cd neo-os-contracts/tests
          dotnet test --verbosity normal --logger:"console;verbosity=detailed"
        
      - name: Run Cypress E2E tests
        run: |
          cd neo-os-services/tests
          npm run cypress:run --spec "e2e/*cy.js"
        
      - name: Upload coverage reports
        uses: codecov/codecov-action@v3
        with:
          files: ./coverage/*.xml
          flags: integration-tests
      
      - name: Stop Neon Express
        if: always()
        run: |
          pkill -f neon-express || true
  
  performance-integration:
    runs-on: ubuntu-latest
    needs: integration-tests
    
    steps:
      - name: Run performance benchmarks
        run: |
          cd neo-os-services/load-tests
          npm run benchmark:integration
```

### Coverage Reporting

#### `package.json` Scripts

```json
{
  "scripts": {
    "test:integration": "run-s test:integration:csharp test:integration:cypress",
    "test:integration:csharp": "dotnet test neo-os-contracts/tests --verbosity normal",
    "test:integration:cypress": "cypress run --headless --spec \"tests/cypress/e2e/**/*.cy.js\"",
    "express:start": "neon-express --config ./.express/config.json",
    "express:stop": "pkill -f neon-express",
    "express:deploy-testnet": "cd tests/integration && node scripts/deploy-contracts.mjs --deploy",
    "express:setup-env": "cd tests/integration && node scripts/setup-environment.mjs",
    "express:cleanup": "cd tests/integration && node scripts/cleanup-test-state.mjs",
    "coverage:integration": "nyc --reporter=lcov --reporter=text-summary npm run test:integration"
  }
}
```

### Test Data Fixtures

#### `fixtures/pools.json`

```json
{
  "liquidityPools": [
    {
      "id": 1,
      "tokenA": "NEO",
      "tokenB": "GAS",
      "reserveA": "1000000000000",
      "reserveB": "1000000000000",
      "tvlUSD": 2000000,
      "volume24h": 150000,
      "fees24h": 750
    },
    {
      "id": 2,
      "tokenA": "NEO",
      "tokenB": "NEO",
      "reserveA": "500000000000",
      "reserveB": "500000000000",
      "tvlUSD": 1000000,
      "volume24h": 50000,
      "fees24h": 250
    }
  ]
}
```

#### `fixtures/users.json`

```json
{
  "testUsers": [
    {
      "address": "0xUser001000000000000000000000000000001",
      "neoBalance": "100000000000",
      "gasBalance": "100000000000",
      "role": "trader",
      "created": "2026-09-06T00:00:00Z"
    },
    {
      "address": "0xUser002000000000000000000000000000002",
      "neoBalance": "50000000000",
      "gasBalance": "50000000000",
      "role": "liquidity-provider",
      "created": "2026-09-06T00:00:00Z"
    }
  ]
}
```

### Troubleshooting

Common issues and solutions:

1. **Neon Express fails to start**: Clear data directory and restart
   ```bash
   rm -rf neo-os-services/.express/data/*
   npm run express:start
   ```

2. **Contract deployment timeout**: Increase timeout in `deploy-contracts.mjs`
   ```javascript
   const timeout = 60000; // Change from 30s to 60s
   ```

3. **Insufficient GAS for transactions**: Request test GAS from faucet
   ```bash
   curl -X POST http://localhost:10332/faucet \
     -H "Content-Type: application/json" \
     -d '{"address":"0xYourAddress","amount":100000}'
   ```

4. **WebSocket connection refused**: Check if WebSocket plugin enabled in config
   ```json
   {
     "plugins": {
       "WebSocket": { "enable": true, "port": 10333 }
     }
   }
   ```

### Monitoring & Metrics

Track integration test health via Prometheus metrics exposed at `/metrics`:

- `neoswap_pools_count` - Number of active liquidity pools
- `neoswap_swap_duration_seconds` - Histogram of swap execution time
- `neoswap_user_count` - Number of registered users
- `neoswap_tvl_usd` - Total value locked across all pools
- `neoswap_fees_collected` - Cumulative fees earned

Run Grafana dashboard for visualization:
```bash
docker run -d -p 3000:3000 grafana/grafana
# Import dashboard: docs/grafana/neoswap-integration-dashboard.json
```

---

**Next Steps**: Proceed with JMeter load testing configuration and security vulnerability scanning.
