//! AddressCache - Account address computation cache
//! 
//! Caches computed addresses from public keys/hashes.
//! Address computations involve cryptographic hash operations that can be
//! cached since they're deterministic and don't change frequently.

use std::sync::Arc;
use anyhow::{Context, Result};
use redis::prelude::*;

use crate::client::RedisClientInstance;
use crate::metrics::{self, record_hit, record_miss};
use chrono::Utc;

/// Cached address entry with metadata
#[derive(Debug, Clone)]
pub struct CachedAddress {
    /// The computed address string
    pub address: String,
    /// Hash used to compute this address (for caching lookup)
    pub source_hash: String,
    /// Chain family identifier
    pub chain_family: String,
    /// When cached
    pub cached_at: i64,
}

impl CachedAddress {
    pub fn new(address: &str, source_hash: &str, chain_family: &str) -> Self {
        Self {
            address: address.to_string(),
            source_hash: source_hash.to_string(),
            chain_family: chain_family.to_string(),
            cached_at: Utc::now().timestamp(),
        }
    }
    
    pub fn to_json(&self) -> Result<String> {
        serde_json::to_string(self).context("Failed to serialize address cache entry")
    }
    
    pub fn from_json(json: &str) -> Result<Self> {
        serde_json::from_str(json).context("Failed to deserialize address cache entry")
    }
}

/// Address computation cache
pub struct AddressCache {
    redis: Arc<RedisClientInstance>,
    default_ttl: u64,
}

impl AddressCache {
    pub fn new(redis: Arc<RedisClientInstance>) -> Self {
        Self {
            redis,
            default_ttl: 3600, // 1 hour TTL for addresses
        }
    }
    
    /// Compute an address using cached hash if available, otherwise compute
    pub async fn compute_address(
        &self,
        chain: &str,
        public_key_hash: &[u8],
        compute_fn: impl FnOnce() -> Result<String>,
    ) -> Result<String> {
        let hash_hex = hex::encode(public_key_hash);
        let cache_key = format!("address:{}:{}", chain, hash_hex);
        
        match self.redis.get(&cache_key).await {
            Ok(Some(json)) => {
                record_hit("address");
                
                let cached = CachedAddress::from_json(&json)?;
                
                tracing::debug!(
                    "Address cache HIT for chain={} hash={}",
                    chain,
                    &hash_hex[..8]
                );
                
                Ok(cached.address)
            }
            Ok(None) | Err(_) => {
                record_miss("address");
                
                let address = compute_fn()?;
                
                // Store in cache
                let cached = CachedAddress::new(&address, &hash_hex, chain);
                let json = cached.to_json()?;
                
                self.redis.set(&cache_key, &json, Some(self.default_ttl)).await?;
                
                metrics::record_set("address");
                tracing::debug!(
                    "Address cache SET for chain={} hash={}",
                    chain,
                    &hash_hex[..8]
                );
                
                Ok(address)
            }
        }
    }
    
    /// Invalidate a cached address
    pub async fn invalidate(&self, chain: &str, hash: &[u8]) -> Result<bool> {
        let hash_hex = hex::encode(hash);
        let cache_key = format!("address:{}:{}", chain, hash_hex);
        
        let deleted = self.redis.delete(&cache_key).await? > 0;
        
        if deleted {
            tracing::debug!("Invalidated address cache for chain={} hash={}", chain, hash_hex);
        }
        
        Ok(deleted)
    }
    
    /// Batch invalidate multiple addresses
    pub async fn invalidate_batch(&self, entries: &[(&str, &[u8])]) -> Result<u64> {
        let mut deleted = 0;
        
        for (chain, hash) in entries {
            if self.invalidate(chain, hash).await? {
                deleted += 1;
            }
        }
        
        Ok(deleted)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[tokio::test]
    async fn test_address_cache_compute() {
        let config = crate::client::RedisConfig {
            hosts: "localhost:6379".to_string(),
            password: None,
            ..Default::default()
        };
        
        let redis = Arc::new(crate::client::RedisClientInstance::new(config).await.unwrap());
        let cache = AddressCache::new(redis);
        
        let chain = "neon3";
        let hash = b"public_key_hash_123";
        let expected_address = "N9p8fGKJxWzHnYvLzXqQjBqPqCqRrSsTtU";
        
        // First call - should compute
        let result = cache.compute_address(chain, hash, || {
            Ok(expected_address.to_string())
        }).await.unwrap();
        
        assert_eq!(result, expected_address);
        
        // Second call - should hit cache
        let cached_result = cache.compute_address(chain, hash, || {
            panic!("Should not recompute");
        }).await.unwrap();
        
        assert_eq!(cached_result, expected_address);
        
        // Cleanup
        cache.invalidate(chain, hash).await.unwrap();
    }
}
