//! Redis Cache Layer for NeoOS Services
//! 
//! High-performance distributed caching layer with multiple specialized caches:
//! - PolicyCache: Signer policy lookups (critical path)
//! - PublicKeyCache: Public key derivations  
//! - AddressCache: Account address computations
//! - QueryCache: Expensive blockchain query results
//! 
//! Features:
//! - Production-ready Redis connection pooling
//! - Cluster mode and Sentinel support
//! - Prometheus metrics integration
//! - Graceful degradation on failures
//! - Configurable TTL per cache type

pub mod client;
pub mod policy_cache;
pub mod pubkey_cache;
pub mod address_cache;
pub mod query_cache;
pub mod metrics;

// Re-export main components
pub use client::{RedisClientInstance, RedisConfig, get_redis_client, initialize_redis_client};
pub use policy_cache::PolicyCache;
pub use pubkey_cache::PublicKeyCache;
pub use address_cache::AddressCache;
pub use query_cache::QueryCache;
pub use metrics::{CacheMetrics, init_metrics};

use anyhow::Result;
use std::sync::Arc;

/// Unified cache manager that coordinates all specialized caches
pub struct CacheManager {
    /// Core Redis client instance
    pub redis: Arc<RedisClientInstance>,
    /// Policy lookup cache
    pub policy: Arc<PolicyCache>,
    /// Public key derivation cache
    pub pubkey: Arc<PublicKeyCache>,
    /// Address computation cache
    pub address: Arc<AddressCache>,
    /// Blockchain query cache
    pub query: Arc<QueryCache>,
}

impl CacheManager {
    /// Create a new cache manager instance with all specialized caches
    pub async fn new(redis: Arc<RedisClientInstance>) -> Result<Self> {
        let policy = Arc::new(PolicyCache::new(Arc::clone(&redis)));
        let pubkey = Arc::new(PublicKeyCache::new(Arc::clone(&redis)));
        let address = Arc::new(AddressCache::new(Arc::clone(&redis)));
        let query = Arc::new(QueryCache::new(Arc::clone(&redis)));

        Ok(Self {
            redis,
            policy,
            pubkey,
            address,
            query,
        })
    }

    /// Get a reference to the Redis client
    pub fn redis(&self) -> &RedisClientInstance {
        &self.redis
    }

    /// Check if all caches are healthy
    pub fn is_healthy(&self) -> bool {
        self.redis.is_healthy()
    }

    /// Flush all cache entries (for testing/cleanup)
    pub async fn flush_all(&self) -> Result<()> {
        Ok(self.redis.flush_all().await?)
    }

    /// Shutdown all caches gracefully
    pub async fn shutdown(&self) {
        info!("Shutting down all caches...");
        self.redis.shutdown().await;
    }
}

/// Factory function to create cache manager from environment configuration
pub async fn create_cache_manager_from_env() -> Result<CacheManager> {
    // Read Redis configuration from environment variables
    let hosts = std::env::var("REDIS_HOSTS")
        .unwrap_or_else(|_| "localhost:6379".to_string());
    
    let password = std::env::var("REDIS_PASSWORD").ok();
    
    let pool_size: usize = std::env::var("REDIS_POOL_SIZE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(50);
    
    let cluster_mode = std::env::var("REDIS_CLUSTER_MODE")
        .ok()
        .map(|s| s == "true")
        .unwrap_or(false);

    let config = RedisConfig {
        hosts,
        password,
        pool_size,
        cluster_mode,
        ..Default::default()
    };

    let redis = Arc::new(RedisClientInstance::new(config).await?);
    CacheManager::new(redis).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_cache_manager_creation() {
        let mock_redis = Arc::new(RedisClientInstance::new(
            RedisConfig {
                hosts: "localhost:6379".to_string(),
                ..Default::default()
            }
        ).await.unwrap());

        let manager = CacheManager::new(mock_redis.clone()).await.unwrap();
        
        assert!(manager.is_healthy());
        assert_eq!(manager.redis(), &mock_redis);
    }
}
