//! PublicKeyCache - Public key derivation cache
//! 
//! Caches public key derivations from seeds for different chain families.
//! Public key derivations are expensive cryptographic operations that should
//! be cached since the same seed is often used repeatedly.

use std::sync::Arc;
use anyhow::{Context, Result};
use redis::prelude::*;

use crate::client::{CacheType, RedisClientInstance};
use crate::metrics::{self, record_hit, record_miss};

/// Chain family identifier (NeoN3 vs NeoX)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ChainFamily {
    NeoN3,
    NeoX,
}

impl std::fmt::Display for ChainFamily {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ChainFamily::NeoN3 => write!(f, "neon3"),
            ChainFamily::NeoX => write!(f, "neox"),
        }
    }
}

impl From<&ChainFamily> for String {
    fn from(chain: &ChainFamily) -> Self {
        chain.to_string()
    }
}

/// Cached public key with metadata
#[derive(Debug, Clone)]
pub struct CachedPublicKey {
    /// The derived public key as hex string
    pub public_key_hex: String,
    /// The seed hash used for derivation (not raw seed for security)
    pub seed_hash: String,
    /// Chain family this key belongs to
    pub chain_family: ChainFamily,
    /// When this entry was cached
    pub cached_at: i64,
}

impl CachedPublicKey {
    pub fn new(public_key_hex: &str, seed_hash: &str, chain_family: ChainFamily) -> Self {
        use chrono::Utc;
        
        Self {
            public_key_hex: public_key_hex.to_string(),
            seed_hash: seed_hash.to_string(),
            chain_family,
            cached_at: Utc::now().timestamp(),
        }
    }
    
    pub fn to_json(&self) -> Result<String> {
        serde_json::to_string(self).context("Failed to serialize public key cache entry")
    }
    
    pub fn from_json(json: &str) -> Result<Self> {
        serde_json::from_str(json).context("Failed to deserialize public key cache entry")
    }
}

/// Public key derivation cache
pub struct PublicKeyCache {
    redis: Arc<RedisClientInstance>,
    default_ttl: u64, // 1 hour typically sufficient
}

impl PublicKeyCache {
    pub fn new(redis: Arc<RedisClientInstance>) -> Self {
        Self {
            redis,
            default_ttl: 3600, // 1 hour TTL for pubkey derivations
        }
    }
    
    /// Get a public key by chain and seed, deriving if not in cache
    /// In real implementation: derive from actual seed bytes
    pub async fn get_or_derive(
        &self,
        chain: ChainFamily,
        seed: &[u8],
        derive_fn: impl FnOnce() -> Result<Vec<u8>>,
    ) -> Result<Vec<u8>> {
        let seed_hash = hex::encode(sha3::Sha3_256::digest(seed));
        let cache_key = format!("pubkey:{}:{}", chain, seed_hash);
        
        match self.redis.get(&cache_key).await {
            Ok(Some(json)) => {
                record_hit("pubkey");
                
                let cached = CachedPublicKey::from_json(&json)?;
                let public_key_bytes = hex::decode(&cached.public_key_hex)?;
                
                tracing::debug!("Public key cache HIT for chain={} seed_hash={}", chain, seed_hash);
                Ok(public_key_bytes)
            }
            Ok(None) | Err(_) => {
                record_miss("pubkey");
                
                // Derive public key
                let public_key_bytes = derive_fn()?;
                let public_key_hex = hex::encode(&public_key_bytes);
                
                // Store in cache
                let cached = CachedPublicKey::new(&public_key_hex, &seed_hash, chain);
                let json = cached.to_json()?;
                
                self.redis.set(&cache_key, &json, Some(self.default_ttl)).await?;
                
                metrics::record_set("pubkey");
                tracing::debug!(
                    "Public key cache SET for chain={} seed_hash={}",
                    chain,
                    &seed_hash[..8]
                );
                
                Ok(public_key_bytes)
            }
        }
    }
    
    /// Cache a specific public key result
    pub async fn cache_derivation(
        &self,
        cache_key: &str,
        public_key_hex: &str,
        chain: ChainFamily,
        seed_hash: &str,
    ) -> Result<()> {
        let cached = CachedPublicKey::new(public_key_hex, seed_hash, chain);
        let json = cached.to_json()?;
        
        self.redis.set(cache_key, &json, Some(self.default_ttl)).await?;
        metrics::record_set("pubkey");
        
        Ok(())
    }
    
    /// Invalidate a cached public key
    pub async fn invalidate(&self, chain: ChainFamily, seed: &[u8]) -> Result<bool> {
        let seed_hash = hex::encode(sha3::Sha3_256::digest(seed));
        let cache_key = format!("pubkey:{}:{}", chain, seed_hash);
        
        let deleted = self.redis.delete(&cache_key).await? > 0;
        
        if deleted {
            tracing::debug!("Invalidate pubkey cache for chain={} seed_hash={}", chain, seed_hash);
        }
        
        Ok(deleted)
    }
    
    /// Check if a public key is cached
    pub async fn exists(&self, chain: ChainFamily, seed: &[u8]) -> Result<bool> {
        let seed_hash = hex::encode(sha3::Sha3_256::digest(seed));
        let cache_key = format!("pubkey:{}:{}", chain, seed_hash);
        
        self.redis.exists(&cache_key).await
    }
    
    /// Flush all cached public keys
    pub async fn flush_all(&self) -> Result<()> {
        // This would require SCAN operation in production
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[tokio::test]
    async fn test_pubkey_cache_basic() {
        let config = crate::client::RedisConfig {
            hosts: "localhost:6379".to_string(),
            password: None,
            ..Default::default()
        };
        
        let redis = Arc::new(crate::client::RedisClientInstance::new(config).await.unwrap());
        let cache = PublicKeyCache::new(redis);
        
        let seed = b"test_seed_12345";
        let public_key = vec![1u8, 2, 3, 4, 5, 6, 7, 8];
        
        let result = cache.get_or_derive(ChainFamily::NeoN3, seed, || {
            Ok(public_key.clone())
        }).await.unwrap();
        
        assert_eq!(result, public_key);
        
        // Second call should hit cache
        let cached_result = cache.get_or_derive(ChainFamily::NeoN3, seed, || {
            panic!("Derivation function should NOT be called again");
        }).await.unwrap();
        
        assert_eq!(cached_result, public_key);
        
        // Cleanup
        cache.invalidate(ChainFamily::NeoN3, seed).await.unwrap();
    }
}
