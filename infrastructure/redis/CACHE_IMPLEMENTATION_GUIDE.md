# Redis Caching Layer Implementation Guide for NeoOS Services

## Executive Summary

This guide documents the comprehensive Redis caching layer implementation designed to reduce API latency p99 from 80ms to <50ms and achieve >90% cache hit rate, reducing database load by ≥60%.

**Implementation Status**: ✅ COMPLETE - All cache modules implemented with tests

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Cache Modules](#cache-modules)
3. [Integration Guide](#integration-guide)
4. [Performance Monitoring](#performance-monitoring)
5. [Best Practices](#best-practices)
6. [Troubleshooting](#troubleshooting)

---

## Architecture Overview

### Cache Hierarchy

```
┌─────────────────────────────────────────────────────────────┐
│                    Application Layer                         │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   CacheManager (Unified)                    │
│   • PolicyCache (5min TTL)                                  │
│   • PublicKeyCache (1hr TTL)                                │
│   • AddressCache (1hr TTL)                                  │
│   • QueryCache (5min TTL)                                   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  Redis Client Instance                      │
│   • Connection Pooling (50 connections)                     │
│   • Automatic Failover                                      │
│   • Health Checks                                           │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│  Redis Cluster│    │ Sentinel HA   │    │ Metrics       │
│  (6 nodes)    │    │ (3 sentinels) │    │ Prometheus    │
└───────────────┘    └───────────────┘    └───────────────┘
```

### Design Principles

1. **Graceful Degradation**: If Redis fails, fallback to direct database queries
2. **Strategic TTLs**: Policies cached longer than dynamic query results
3. **Batch Invalidation**: Multiple keys invalidated atomically
4. **Metrics-Driven**: Every cache operation tracked for optimization

---

## Cache Modules

### 1. Policy Cache (Critical Path)

**Purpose**: Cache signer policy lookups - most frequent read in signing flow  
**TTL**: 300 seconds (5 minutes)  
**Expected Hit Rate**: >95%  

#### Usage Pattern

```rust
use redis_cache::{CacheManager, PolicyCache};

async fn sign_transaction_with_cache(
    cache_manager: &CacheManager,
    key_id: &str,
) -> anyhow::Result<SignerPolicy> {
    // Try cache first
    match cache_manager.policy.get_policy(key_id).await {
        Ok(Some(cached)) => {
            tracing::info!("Policy cache HIT for {}", key_id);
            serde_json::from_str(cached.to_json())?
        }
        Ok(None) | Err(_) => {
            // Fallback to database
            let policy = db_fetch_policy(key_id).await?;
            
            // Store in cache for future calls
            if let Some(p) = &policy {
                let json = serde_json::to_string(p)?;
                cache_manager.policy.set_policy(key_id, &json, None).await?;
            }
            
            policy.unwrap_or_default()
        }
    }
}
```

#### Invalidations

Call these when policies are updated in database:

```rust
// Single key invalidation
cache_manager.policy.invalidate_policy(&key_id).await?;

// Batch invalidation for admin operations
let key_ids = vec!["key-1", "key-2", "key-3"];
cache_manager.policy.invalidate_batch(&key_ids).await?;
```

---

### 2. Public Key Derivation Cache

**Purpose**: Cache expensive cryptographic derivations  
**TTL**: 3600 seconds (1 hour)  
**Expected Hit Rate**: >90%  

#### Usage Pattern

```rust
use redis_cache::{PublicKeyCache, ChainFamily};

async fn get_public_key(cache: &PublicKeyCache, chain: ChainFamily, seed: &[u8]) -> Result<Vec<u8>> {
    cache.get_or_derive(chain, seed, || {
        // This is expensive - crypto::derive_public_key(seed)
        Ok(crypto::derive_public_key(seed)?)
    }).await
}
```

---

### 3. Address Computation Cache

**Purpose**: Cache computed addresses from public key hashes  
**TTL**: 3600 seconds (1 hour)  
**Expected Hit Rate**: >95%  

#### Usage Pattern

```rust
use redis_cache::AddressCache;

async fn get_display_address(
    cache: &AddressCache,
    chain: &str,
    hash: &[u8],
) -> Result<String> {
    cache.compute_address(chain, hash, || {
        Ok(crypto::compute_address(chain, hash)?.to_string())
    }).await
}
```

---

### 4. Query Result Cache

**Purpose**: Cache expensive blockchain RPC queries  
**TTL**: 300 seconds (5 minutes) - configurable per query  
**Expected Hit Rate**: >80%  

#### Usage Pattern

```rust
use redis_cache::QueryCache;

async fn get_block_height(cache: &QueryCache) -> Result<u32> {
    let result_json = cache.get_or_query("block_height", || async {
        // Expensive RPC call
        let block_height = rpc_client.get_latest_block().await?;
        Ok(serde_json::to_string(&block_height)?)
    }).await?;
    
    let query_result: BlockHeightResponse = serde_json::from_str(&result_json)?;
    Ok(query_result.height)
}
```

---

## Integration Guide

### Step 1: Add Dependencies

Add to your service's `Cargo.toml`:

```toml
[dependencies]
redis-cache = { path = "../../workers/redis-cache" }
```

### Step 2: Initialize Cache Manager

In your application startup code:

```rust
use redis_cache::{CacheManager, create_cache_manager_from_env};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Initialize cache manager from environment variables
    let cache_manager = create_cache_manager_from_env().await?;
    
    // Optionally run background metrics tracker
    tokio::spawn(async move {
        redis_cache::metrics::run_hit_rate_tracker().await;
    });
    
    // Use cache_manager throughout your application...
    
    Ok(())
}
```

### Step 3: Configure Environment Variables

Create `.env` file or set environment variables:

```bash
# Redis connection
REDIS_HOSTS=localhost:6379
REDIS_PASSWORD=your-strong-password
REDIS_CLUSTER_MODE=false
REDIS_POOL_SIZE=50

# Cache TTLs
CACHE_POLICY_TTL=300
CACHE_PUBKEY_TTL=3600
CACHE_ADDRESS_TTL=3600
CACHE_QUERY_TTL=300

# Monitoring
REDIS_METRICS_ENABLED=true
```

### Step 4: Integrate into Sign Service

Modify your `service.rs` to use cache:

```rust
// Before adding cache:
pub async fn sign_transaction(...) -> Result<SignResponse> {
    let policy = self.repository.signer_policy_or_default(key_id)?;
    // ... rest of signing logic
}

// After adding cache:
pub async fn sign_transaction_with_cache(...) -> Result<SignResponse> {
    // Try cache first
    let cached_policy = self.cache_manager.policy.get_policy(key_id).await?;
    
    let policy = match cached_policy {
        Some(cached) => {
            serde_json::from_str(cached.to_json())?
        }
        None => {
            // Load from DB
            let policy = self.repository.signer_policy_or_default(key_id)?;
            
            // Cache it
            if let Some(p) = &policy {
                let json = serde_json::to_string(p)?;
                self.cache_manager.policy.set_policy(key_id, &json, None).await?;
            }
            
            policy
        }
    };
    
    // Continue with normal signing logic...
}
```

### Step 5: Add Invalidation Hooks

When saving a new policy to database:

```rust
pub async fn save_policy_with_invalidation(
    &self,
    credentials: &CallerCredentials,
    id: &str,
    policy: &SignerPolicy,
) -> Result<Outcome<SignerPolicy>> {
    // Save to database
    let stored_policy = self.repository.save_signer_policy(id, policy, now_unix()?)?;
    
    // Invalidate cache so next request fetches fresh data
    self.cache_manager.policy.invalidate_policy(id).await.ok();
    
    Ok(Outcome::Allowed(stored_policy))
}
```

---

## Performance Monitoring

### Prometheus Metrics

All cache operations emit Prometheus metrics:

```
# HELP redis_cache_hits_total Total number of cache hits
# TYPE redis_cache_hits_total counter
redis_cache_hits_total{type="policy"} 125000

# HELP redis_cache_misses_total Total number of cache misses
redis_cache_misses_total{type="policy"} 5000

# HELP redis_cache_hit_rate_percent Current cache hit rate percentage
redis_cache_hit_rate_percent{type="policy"} 96.15

# HELP redis_memory_used_bytes Memory usage in bytes
redis_memory_used_bytes{type="policy"} 1048576

# HELP redis_evicted_keys_total Total evicted keys
redis_evicted_keys_total{type="policy"} 150
```

### Grafana Dashboards

Dashboard JSON template located at: `infrastructure/redis/grafana/neoos-cache-dashboard.json`

**Key Panels:**
1. Cache Hit Rate Over Time (by type)
2. Average Latency (GET operations)
3. Memory Usage Trends
4. Eviction Events Log
5. Database Query Reduction Estimate

### Alert Rules

Configure alerts in Prometheus/Grafana:

```yaml
groups:
  - name: cache_alerts
    rules:
      # Low hit rate alert
      - alert: LowCacheHitRate
        expr: redis_cache_hit_rate_percent < 80
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Redis cache hit rate dropped below 80%"
          
      # High eviction rate
      - alert: HighEvictionRate
        expr: rate(redis_evicted_keys_total[5m]) > 10
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "High cache eviction rate detected"
          
      # Redis connection failures
      - alert: RedisConnectionFailure
        expr: up{job="redis-exporter"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Redis node is unreachable"
```

---

## Best Practices

### 1. TTL Selection Guidelines

| Data Type | Recommended TTL | Rationale |
|-----------|----------------|-----------|
| Policies | 300s (5min) | Change infrequently but need reasonable freshness |
| Public Keys | 3600s (1hr) | Static once derived, never changes |
| Addresses | 3600s (1hr) | Permanent mapping, extremely stable |
| Blockchain Queries | 300s (5min) | Dynamic data, may change frequently |

### 2. Cache Invalidation Strategy

**Options:**
- ✅ **Time-based (Default)**: Rely on TTL expiration
- ⚠️ **Manual**: Invalidate on write operations
- ❌ **Notification-based**: Requires pub/sub infrastructure

**Recommendation**: Hybrid approach for NeoOS:
- Default to time-based TTLs
- Add manual invalidation on explicit writes (policy updates)

### 3. Connection Pool Tuning

```rust
// For high-throughput services (1000+ requests/sec):
REDIS_POOL_SIZE=100
REDIS_MIN_IDLE=25

// For moderate load (100-1000 requests/sec):
REDIS_POOL_SIZE=50
REDIS_MIN_IDLE=10

// For low load (<100 requests/sec):
REDIS_POOL_SIZE=25
REDIS_MIN_IDLE=5
```

### 4. Graceful Degradation Handling

Always implement fallback to database if Redis fails:

```rust
match cache_manager.policy.get_policy(key_id).await {
    Ok(Some(policy)) => use_cached(policy),
    Ok(None) => load_from_database(),
    Err(e) => {
        tracing::error!("Redis error, falling back to DB: {}", e);
        load_from_database()
    }
}
```

### 5. Testing Strategy

```rust
#[cfg(test)]
mod tests {
    use super::*;
    
    #[tokio::test]
    async fn test_cache_with_fallback() {
        // Setup cache with test Redis instance
        let cache_manager = create_test_cache_manager().await;
        
        // First call - cache miss
        let result1 = sign_transaction_with_cache(...).await;
        assert!(result1.is_ok());
        
        // Second call - cache hit
        let result2 = sign_transaction_with_cache(...).await;
        assert!(result2.is_ok());
        
        // Verify same result
        assert_eq!(result1, result2);
    }
    
    #[tokio::test]
    #[ignore] // Requires Redis
    async fn test_cache_performance_under_load() {
        // Benchmark scenario: 1000 concurrent requests
        let handles: Vec<_> = (0..1000)
            .map(|i| tokio::spawn(async move {
                let _ = cache_manager.policy.get_policy(&format!("key-{}", i % 10)).await;
            }))
            .collect();
        
        let start = Instant::now();
        for handle in handles {
            handle.await.unwrap();
        }
        
        println!("Total time: {:?}", start.elapsed());
        // Should complete under 2 seconds for good performance
    }
}
```

---

## Troubleshooting

### Common Issues

#### 1. Cache Stampede (Thundering Herd)

**Symptom**: Multiple simultaneous cache misses causing DB spike

**Solution**: Implement distributed locking or probabilistic early expiration

```rust
pub async fn get_policy_with_lock(&self, key_id: &str) -> Result<Option<CachedPolicy>> {
    let lock_key = format!("lock:policy:{}", key_id);
    
    // Try to acquire lock
    if self.redis.set_if_not_exists(&lock_key, "locked", Some(10)).await? {
        // We got the lock, try to fetch from cache
        if let Some(cached) = self.get_policy(key_id).await? {
            return Ok(Some(cached));
        }
        
        // Cache miss, fetch from database
        let policy = self.load_from_database(key_id).await?;
        
        // Populate cache
        if let Some(p) = &policy {
            let json = serde_json::to_string(p)?;
            self.set_policy(key_id, &json, None).await?;
        }
        
        // Release lock
        self.redis.delete(&lock_key).await?;
    } else {
        // Another thread has the lock, wait and retry cache
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        return self.get_policy(key_id).await;
    }
    
    Ok(policy)
}
```

#### 2. Memory Pressure / OOM

**Symptom**: High memory usage, frequent evictions

**Solutions**:
1. Reduce pool sizes or max entries
2. Shorten TTLs for volatile caches
3. Enable Redis LRU eviction policy:
   ```redis
   CONFIG SET maxmemory-policy allkeys-lru
   ```

#### 3. Stale Data

**Symptom**: Cached values don't reflect latest DB state

**Solution**: 
- Ensure manual invalidation on writes
- Verify TTL isn't too long
- Consider versioned cache keys: `policy:{key_id}:{version}`

#### 4. Slow Cache Operations

**Symptom**: GET operations taking >10ms

**Diagnostics**:
```bash
# Check Redis performance
redis-cli --latency --interval 1

# Check slow log
redis-cli慢日志 GET 10

# Check client connections
redis-cli CLIENT LIST
```

**Optimization**:
- Increase connection pool size
- Ensure proper indexing
- Consider local L1 cache (dashmap) for hottest keys

---

## Next Steps

1. ✅ Monitor initial deployment for 24 hours
2. 📊 Review Grafana dashboards for baseline metrics
3. 🔧 Tune TTLs based on actual access patterns
4. 🧪 Run load tests to validate latency improvements
5. 📈 Gradually increase traffic to target >90% hit rate

---

## Contact & Support

For issues or questions:
- GitHub Issue: Create issue with `[redis-cache]` prefix
- Slack Channel: `#neoos-cache-support`
- Emergency: Page SRE team with `CRITICAL-REDIS` severity

---

*Document Version: 1.0*  
*Last Updated: September 6, 2026*  
*Author: NeoOS Infrastructure Team*
