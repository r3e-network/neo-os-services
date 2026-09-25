# Deployment Environment Setup Guide

## Overview

This guide helps you configure Morpheus services correctly before deployment to prevent accidental network mismatches and security issues.

---

## Quick Start Commands

### Windows PowerShell

```powershell
$env:MORPHEUS_NETWORK="testnet"
npm run check:network-config
```

### Linux/macOS (bash/zsh)

```bash
export MORPHEUS_NETWORK=testnet
npm run check:network-config
```

### Vercel/Cloudflare Dashboard

```
Variable Name: MORPHEUS_NETWORK
Value: testnet (or mainnet)
Environment: production-preview
```

---

## Critical Variables Summary

| Variable                       | Purpose                    | Example Value            | Required    |
| ------------------------------ | -------------------------- | ------------------------ | ----------- |
| `MORPHEUS_NETWORK`             | Main runtime network       | `mainnet` or `testnet`   | ✅ YES      |
| `NEXT_PUBLIC_MORPHEUS_NETWORK` | Client-side identifier     | `mainnet` or `testnet`   | Alternative |
| `UPSTASH_REDIS_REST_URL`       | Rate limiting (production) | `https://xxx.upstash.io` | Production  |
| `SUPABASE_SECRET_KEY`          | Database access            | `sb_...`                 | YES         |
| `MORPHEUS_RUNTIME_TOKEN`       | Runtime authentication     | Random secret            | YES         |

---

## Common Deployment Scenarios

### Scenario 1: Testnet Development

```powershell
# PowerShell
$env:MORPHEUS_NETWORK="testnet"
$env:NEO_NETWORK_MAGIC="894710606"
$env:SIGNER_ROLE_WORKER_KEY_ID="worker-testnet-key"

# Verify
npm run check:network-config -- --expected testnet
```

### Scenario 2: Mainnet Production

```powershell
# PowerShell
$env:MORPHEUS_NETWORK="mainnet"
$env:NEO_NETWORK_MAGIC="860833102"
$env:MORPHEUS_MAINNET_RUNTIME_URL="https://oracle.meshmini.app/mainnet"
$env:UPSTASH_REDIS_REST_URL="redis://prod-instance"

# Verify
npm run check:network-config -- --expected mainnet
```

### Scenario 3: Preview/Staging Environment

```powershell
# Use same as production but different secrets
$env:MORPHEUS_NETWORK="mainnet"
$env:NEXT_PUBLIC_VERCEL_ENV="preview"
$env:SUPABASE_SECRET_KEY="sb_preview_secret_key"
```

---

## Validation Commands

Run these in order before deploying:

```bash
# 1. Basic network configuration
npm run check:network-config

# 2. Full environment validation
npm run check:env

# 3. Web app requirements
npm run check:web-cron-env -- --fail-on-missing

# 4. Signer configuration
npm run check:signers

# 5. Production topology
npm run check:production-topology

# 6. Run smoke tests
MORPHEUS_NETWORK=testnet npm run verify:n3
```

---

## Error Resolution

### Error: "Network not configured"

**Problem:** Neither `MORPHEUS_NETWORK` nor `NEXT_PUBLIC_MORPHEUS_NETWORK` set

**Solution:**

```bash
export MORPHEUS_NETWORK=testnet
# OR in your .env file:
# MORPHEUS_NETWORK=testnet
```

### Error: "Invalid network value"

**Problem:** Typo in network value (e.g., `mianet`)

**Solution:** Check spelling carefully

- ✅ Correct: `mainnet`, `testnet`
- ❌ Wrong: `mianet`, `tests`, `staging`

### Error: "runtime_network_mismatch"

**Problem:** CVM reports different network than expected by control plane

**Solution:**

1. Check all components use same network
2. Verify environment consistency across services
3. Review DEPLOYMENT_CHECKLIST.md section on network mismatch

---

## Pre-Flight Checklist

Before any deployment, verify:

- [ ] Network type clearly documented (testnet vs mainnet)
- [ ] Environment variables exported or configured
- [ ] Validation script passes (`npm run check:network-config`)
- [ ] Contract addresses match target network
- [ ] Signing keys configured for selected network
- [ ] RPC endpoints validated for chosen network
- [ ] Monitoring configured with correct health endpoints

---

## Security Best Practices

1. **Never commit private keys** - Use custody service via `SIGNER_ROLE_*_KEY_ID`
2. **Separate environments** - Never mix testnet/mainnet configs
3. **Rotate credentials regularly** - Update tokens every 90 days minimum
4. **Audit access logs** - Monitor for unauthorized attempts
5. **Use strong secrets** - Minimum 32 characters, random generation

---

## Next Steps

After setting up environment:

1. Deploy to preview/staging first
2. Run end-to-end test suite
3. Monitor error logs for configuration issues
4. Only then deploy to production
5. Enable full monitoring and alerting

See [DEPLOYMENT_CHECKLIST.md](./DEPLOYMENT_CHECKLIST.md) for complete procedures.
