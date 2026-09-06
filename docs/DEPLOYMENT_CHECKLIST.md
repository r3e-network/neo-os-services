# Deployment Checklist / 部署检查清单

## Quick Start / 快速开始

Before deploying Morpheus services, verify all required environment variables are set correctly.

部署 Morpheus 服务前，请验证所有必需的环境变量已正确设置。

**Critical Step:** The `MORPHEUS_NETWORK` variable must be explicitly configured to prevent accidental mainnet deployments.

**关键步骤：** 必须显式配置 `MORPHEUS_NETWORK` 变量以防止意外部署到 mainnet。

---

## Required Environment Variables / 必需环境变量

### Network Selection (CRITICAL) / 网络选择（关键）

| Variable | Required For | Description | Example |
|----------|-------------|-------------|---------|
| `MORPHEUS_NETWORK` | **ALL** | Main Morpheus runtime network selection | `mainnet` or `testnet` |
| `NEXT_PUBLIC_MORPHEUS_NETWORK` | Web apps | Public-facing network identifier for browser clients | `mainnet` or `testnet` |

**⚠️ CRITICAL:** At least one of these variables MUST be set during any deployment. If both are unset, the application will refuse to start with an error message directing you to set the appropriate network variable.

**警告：** 任何部署都必须设置这些变量中的至少一个。如果两者都未设置，应用将拒绝启动并显示错误信息指导你设置适当的网络变量。

---

## Testnet vs Mainnet Configuration / Testnet 与 Mainnet 配置对比

### Key Differences / 主要差异

| Aspect | Testnet | Mainnet |
|--------|---------|---------|
| **Purpose** | Development, testing, staging | Production, live users |
| **Network Magic** | Different value (`1268474290`) | Different value (`860834051`) |
| **Contract Addresses** | Testnet-specific hashes | Production contract hashes |
| **Token Value** | Zero-value test tokens | Real-value assets |
| **Security** | Lower threshold, more permissive | Strict security, production-ready |
| **Rate Limits** | More generous | Stricter limits |
| **RPC Endpoints** | Testnet RPC URLs | Production RPC URLs |
| **Signer Keys** | Separate testnet keys | Production signing keys |

### Configuration Checklist / 配置检查清单

#### Testnet Deployment Checklist / Testnet 部署检查清单

- [ ] `MORPHEUS_NETWORK=testnet` set
- [ ] `NEO_NETWORK_MAGIC=1268474290` (testnet magic)
- [ ] Contract addresses from `config/networks/testnet.json`
- [ ] Testnet signer keys and private keys
- [ ] `MORPHEUS_PAYMASTER_TESTNET_ENABLED=true` (if needed)
- [ ] `MORPHEUS_RELAYER_NEO_N3_SCAN_MODE=request_cursor`
- [ ] Testnet RPC endpoint accessible
- [ ] Supabase instance properly configured for testnet
- [ ] Cloudflare edge gateway configured with testnet origins

#### Mainnet Deployment Checklist / Mainnet 部署检查清单

- [ ] `MORPHEUS_NETWORK=mainnet` set
- [ ] `NEO_NETWORK_MAGIC=860834051` (mainnet magic)
- [ ] Contract addresses from `config/networks/mainnet.json`
- [ ] Production signer keys (custody service configured)
- [ ] `MORPHEUS_MAINNET_RUNTIME_URL` configured
- [ ] All security checks enabled (Upstash rate limiting)
- [ ] Mainnet RPC endpoint with redundancy
- [ ] BetterStack monitoring configured
- [ ] Health check endpoints verified
- [ ] Cron secrets configured for scheduled tasks

---

## Common Errors and Solutions / 常见错误与解决方案

### Error: Network Not Configured / 错误：网络未配置

**Symptom:**
```
Error: MORPHEUS_NETWORK/NEXT_PUBLIC_MORPHEUS_NETWORK is required but not set. Set to "testnet" or "mainnet". Example: export MORPHEUS_NETWORK=testnet
```

**Root Cause:** Neither `MORPHEUS_NETWORK` nor `NEXT_PUBLIC_MORPHEUS_NETWORK` environment variables are defined.

**Solution:**
```bash
# Option 1: Direct export
export MORPHEUS_NETWORK=testnet

# Option 2: Add to .env file
echo "MORPHEUS_NETWORK=testnet" >> .env

# Option 3: Vercel/Cloudflare dashboard
# Set NEXT_PUBLIC_MORPHEUS_NETWORK in your deployment platform
```

**Prevention:** 
- Always verify environment before deploying
- Use deployment workflows with pre-check validation
- Document required variables in team onboarding

---

### Error: Network Mismatch / 错误：网络不匹配

**Error Code:** `runtime_network_mismatch`

**Symptom:**
```
Health check detected network mismatch: CVM reports 'testnet' but origin expects 'mainnet'
```

**Root Cause:** 
- Runtime environment reports different network than expected by control plane
- Mixed configuration between testnet and mainnet endpoints

**Solution:**

1. **Verify Runtime Configuration:**
   ```bash
   curl -X GET https://oracle.meshmini.app/testnet/api/runtime/status
   ```

2. **Check Consistency Across Services:**
   ```bash
   # Ensure all components use same network
   grep -r MORPHEUS_NETWORK deploy/ config/ scripts/
   ```

3. **Update Network-Specific URLs:**
   ```bash
   # Correct mainnet endpoints
   MORPHEUS_MAINNET_RUNTIME_URL=https://oracle.meshmini.app/mainnet
   MORPHEUS_MAINNET_ORIGIN_URL=https://edge.meshmini.app/mainnet
   
   # Correct testnet endpoints  
   MORPHEUS_TESTNET_RUNTIME_URL=https://oracle.meshmini.app/testnet
   MORPHEUS_TESTNET_ORIGIN_URL=https://edge.meshmini.app/testnet
   ```

**Prevention:**
- Never mix testnet and mainnet configurations in same deployment
- Use separate deployment environments for each network
- Validate network consistency in CI/CD pipeline

---

### Error: Invalid Network Value / 错误：无效的网络值

**Symptom:**
```
Error: Invalid MORPHEUS_NETWORK/NEXT_PUBLIC_MORPHEUS_NETWORK value "mianet"; expected "mainnet" or "testnet"
```

**Root Cause:** Typo in environment variable value (e.g., `mianet` instead of `mainnet`)

**Solution:**
```bash
# Double-check spelling
export MORPHEUS_NETWORK=mainnet

# Validate allowed values only
echo "Allowed values: mainnet, testnet"
```

**Common Typos:**
- ❌ `mianet` → ✅ `mainnet`
- ❌ `tests` → ✅ `testnet`
- ❌ `production` → ✅ `mainnet`
- ❌ `staging` → ✅ `testnet`

---

## Pre-Deployment Validation / 部署前验证

Run these commands before deploying:

```bash
# Check root environment variables
npm run check:env

# Verify web app environment
npm run check:web-cron-env -- --fail-on-missing

# Check network-specific configuration
node scripts/check-nitro-env.mjs

# Validate production topology
npm run check:production-topology

# Run smoke tests
npm run smoke:control-plane
MORPHEUS_NETWORK=testnet npm run verify:n3
```

---

## Windows PowerShell Setup / Windows PowerShell 配置

For Windows users using PowerShell:

```powershell
# Set environment variable for current session
$env:MORPHEUS_NETWORK="testnet"

# Set environment variable persistently (requires admin)
[System.Environment]::SetEnvironmentVariable("MORPHEUS_NETWORK", "testnet", "Machine")

# Verify setting
echo $env:MORPHEUS_NETWORK
```

**Note:** Unlike bash, PowerShell uses semicolons (`;`) instead of `&&` for command chaining.

---

## Troubleshooting Debugging Guide / 故障排查指南

### Step 1: Verify Environment Variables / 验证环境变量

```bash
# List all Morpheus network variables
env | grep MORPHEUS_NETWORK

# Check both runtime and public versions
echo "Runtime: $MORPHEUS_NETWORK"
echo "Public: $NEXT_PUBLIC_MORPHEUS_NETWORK"
```

### Step 2: Check Runtime Status / 检查运行时状态

```bash
# Test health endpoint
curl https://oracle.meshmini.app/testnet/api/runtime/status

# Expected response includes network identifier
```

### Step 3: Inspect Logs / 检查日志

```bash
# Watch logs for network-related errors
docker logs --follow morpheus-web-app 2>&1 | grep -i network

# Look for specific error patterns
grep -r "MORPHEUS_NETWORK.*required" logs/
```

### Step 4: Validate Configuration Files / 验证配置文件

```bash
# Compare with expected network configs
diff <(cat config/networks/testnet.json) <(expected_values)

# Check contract addresses match network
jq '.contractAddress' config/networks/{mainnet,testnet}.json
```

---

## Best Practices / 最佳实践

### 1. Environment Separation / 环境隔离

- **Never share environment variables** between testnet and mainnet
- Use separate deployment pipelines for each network
- Maintain distinct `.env.production.testnet` and `.env.production.mainnet` files

### 2. Security Hardening / 安全加固

- Always use custody signer service for mainnet
- Enable Upstash rate limiting in production
- Configure BetterStack monitoring alerts
- Rotate keys regularly and audit access logs

### 3. Monitoring & Alerting / 监控与告警

- Deploy BetterStack heartbeats for both networks
- Monitor health endpoints every 2 minutes
- Set up alerts for network mismatch errors
- Track failed deployments due to missing env vars

### 4. CI/CD Integration / CI/CD 集成

```yaml
# Example GitHub Actions pre-deploy check
name: Pre-Deploy Network Validation
on: [push]
jobs:
  validate-network:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Check Network Configuration
        run: |
          if [ -z "$MORPHEUS_NETWORK" ]; then
            echo "❌ ERROR: MORPHEUS_NETWORK not set"
            exit 1
          fi
          if [[ ! "$MORPHEUS_NETWORK" =~ ^(mainnet|testnet)$ ]]; then
            echo "❌ ERROR: Invalid network value: $MORPHEUS_NETWORK"
            exit 1
          fi
          echo "✅ Network validated: $MORPHEUS_NETWORK"
```

---

## Additional Resources / 更多资源

- [Environment Reference](./ENVIRONMENT.md) - Complete variable documentation
- [Deployment Guide](./DEPLOYMENT.md) - Full deployment process
- [Architecture Documentation](./ARCHITECTURE.md) - System architecture overview
- [Operations Manual](./OPERATIONS.md) - Running and maintaining services

---

## Contact Support / 联系支持

For deployment issues, contact:
- **Slack Channel:** #morpheus-support
- **Email:** morpheus-ops@r3e.network
- **On-Call Pager:** See internal wiki

**Always include:**
- Network type (testnet/mainnet)
- Error messages
- Environment variable dump (redacted)
- Timestamp of issue onset
