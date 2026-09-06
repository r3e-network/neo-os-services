//! Policy Cache - Signer policy lookups (CRITICAL PATH)
//!
//! This cache is on the critical signing path and should be prioritized.
//! Policies change infrequently but are read constantly during signature operations.
//! High TTL is appropriate as policy changes are relatively rare events.

use std::sync::Arc;
use anyhow::{Context, Result};
use chrono::{Duration, Utc};
use redis::prelude::*;

use crate::{
    client::{CacheType, RedisClientInstance},
    metrics::{self, record_hit, record_miss},
};

/// Cached signer policy with metadata
#[derive(Debug, Clone)]
pub struct CachedPolicy {
    /// The policy data as JSON string
    pub policy_json: String,
    /// Key ID this policy belongs to
    pub key_id: String,
    /// When this entry was cached
    pub cached_at: i64,
    /// Current time-to-live in seconds
    pub ttl: u64,
}

impl CachedPolicy {
    /// Create a new cached policy from JSON data
    pub fn from_json(policy_json: &str, key_id: &str) -> Self {
        Self {
            policy_json: policy_json.to_string(),
            key_id: key_id.to_string(),
            cached_at: Utc::now().timestamp(),
            ttl: 300, // Default 5 minutes
        }
    }
    
    /// Check if this cache entry has expired based on TTL
    pub fn is_expired(&self, ttl: u64) -> bool {
        let now = Utc::now().timestamp();
        let age = Duration::seconds(now - self.cached_at);
        let age_millis = age.num_milliseconds() as u64;
        
        age_millis >= ttl * 1000
    }
    
    /// Convert back to JSON string
    pub fn to_json(&self) -> &str {
        &self.policy_json
    }
}

/// Policy lookup cache optimized for frequent reads, infrequent writes
pub struct PolicyCache {
    /// Redis client instance
    redis: Arc<RedisClientInstance>,
    /// Default TTL for policy entries (in seconds)
    default_ttl: u64,
    /// Maximum number of entries (approximate, via LRU eviction)
    max_entries: usize,
}

impl PolicyCache {
    /// Create a new PolicyCache instance
    pub fn new(redis: Arc<RedisClientInstance>) -> Self {
        Self {
            redis,
            default_ttl: 300, // 5 minutes - balances freshness vs hit rate
            max_entries: 10_000, // Typical policy count
        }
    }
    
    /// Set default TTL
    pub fn with_default_ttl(mut self, ttl: u64) -> Self {
        self.default_ttl = ttl;
        self
    }
    
    /// Set maximum number of entries
    pub fn with_max_entries(mut self, max_entries: usize) -> Self {
        self.max_entries = max_entries;
        self
    }
    
    /// Get a signed policy by key ID from cache
    /// Returns None if not found or expired
    pub async fn get_policy(&self, key_id: &str) -> Result<Option<CachedPolicy>> {
        let cache_key = format!("policy:{}", key_id);
        
        // Try cache first
        match self.redis.get(&cache_key).await {
            Ok(Some(json)) => {
                // Successful cache HIT
                record_hit("policy");
                
                // Parse and validate cache entry
                let cached: CachedPolicy = serde_json::from_str(&json)
                    .context("Failed to deserialize cached policy")?;
                
                // Verify expiration
                if !cached.is_expired(self.default_ttl) {
                    return Ok(Some(cached));
                } else {
                    // Expired entry - remove it
                    self.delete_policy(key_id).await.ok();
                }
            }
            Ok(None) => {
                // Cache MISS - will trigger database fetch
                record_miss("policy");
            }
            Err(e) => {
                // Cache error - log but continue with database
                tracing::warn!("Redis GET failed for policy {}: {}", key_id, e);
                record_miss("policy");
            }
        }
        
        Ok(None)
    }
    
    /// Store a policy in cache (typically after fetching from database)
    pub async fn set_policy(
        &self, 
        key_id: &str,
        policy_json: &str,
        ttl: Option<u64>
    ) -> Result<()> {
        let cache_key = format!("policy:{}", key_id);
        let ttl_seconds = ttl.unwrap_or(self.default_ttl);
        
        // Create cache entry
        let cached = CachedPolicy::from_json(policy_json, key_id);
        cached.ttl = ttl_seconds;
        
        let json = serde_json::to_string(&cached)
            .context("Failed to serialize policy cache entry")?;
        
        // Set in Redis with TTL
        self.redis.set(&cache_key, &json, Some(ttl_seconds)).await?;
        
        // Record metrics
        metrics::record_set("policy");
        metrics::set_ttl("policy", ttl_seconds);
        
        tracing::debug!(
            "Policy cache SET {} for key_id={}",
            if cache_key.len() > 20 { &cache_key[..20] } else { &cache_key },
            key_id
        );
        
        Ok(())
    }
    
    /// Invalidate a specific policy entry (call when policy is updated in DB)
    pub async fn invalidate_policy(&self, key_id: &str) -> Result<bool> {
        let cache_key = format!("policy:{}", key_id);
        let deleted = self.redis.delete(&cache_key).await?;
        
        if deleted > 0 {
            tracing::debug!("Invalidated policy cache for key_id: {}", key_id);
        }
        
        Ok(deleted > 0)
    }
    
    /// Delete all policy entries for multiple key IDs
    pub async fn invalidate_batch(&self, key_ids: &[&str]) -> Result<u64> {
        let mut pipe = Pipeline::new();
        let mut delete_keys = Vec::with_capacity(key_ids.len());
        
        for key_id in key_ids {
            let cache_key = format!("policy:{}", key_id);
            delete_keys.push(cache_key.clone());
            pipe.del(&cache_key);
        }
        
        let result = pipe.query_async::<()>().await;
        
        match result {
            Ok(results) => Ok(delete_keys.len() as u64),
            Err(_) => {
                // If pipeline fails, fall back to individual deletes
                let mut deleted = 0;
                for key_id in key_ids {
                    let cache_key = format!("policy:{}", key_id);
                    if self.redis.delete(&cache_key).await? > 0 {
                        deleted += 1;
                    }
                }
                Ok(deleted)
            }
        }
    }
    
    /// Get or load policy from provided loader function
    /// This is the main access pattern - try cache first, fallback to loader
    pub async fn get_or_load<F, Fut>(&self, key_id: &str, loader: F) -> Result<Option<CachedPolicy>>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<String>>,
    {
        // Try cache first
        if let Some(cached) = self.get_policy(key_id).await? {
            return Ok(Some(cached));
        }
        
        // Cache miss - use loader
        let policy_json = loader().await?;
        
        // Store in cache for future lookups
        self.set_policy(key_id, &policy_json, None).await?;
        
        Ok(Some(CachedPolicy::from_json(&policy_json, key_id)))
    }
    
    /// Check if a policy exists in cache
    pub async fn exists(&self, key_id: &str) -> Result<bool> {
        let cache_key = format!("policy:{}", key_id);
        self.redis.exists(&cache_key).await
    }
    
    /// Get raw cache key for testing/debugging
    pub fn cache_key(key_id: &str) -> String {
        format!("policy:{}", key_id)
    }
    
    /// Flush all policy cache entries (for testing only!)
    pub async fn flush_all(&self) -> Result<()> {
        let keys = self.list_all_keys().await?;
        
        for key in keys {
            self.redis.delete(&key).await?;
        }
        
        Ok(())
    }
    
    /// List all policy keys (for debugging/testing only)
    pub async fn list_all_keys(&self) -> Result<Vec<String>> {
        let search_pattern = "policy:*";
        
        // Use SCAN command to find all matching keys
        // Note: In production, you'd need a connection that supports SCAN
        // This is a simplified version
        
        Ok(Vec::new()) // Return empty for now - requires more advanced Redis interaction
    }
    
    /// Get statistics about policy cache
    pub async fn stats(&self) -> Result<PolicyCacheStats> {
        // Count total cached policies
        // This would require SCAN or similar operation
        
        Ok(PolicyCacheStats {
            max_entries: self.max_entries,
            default_ttl: self.default_ttl,
            // These would be computed from Redis INFO/MONITOR commands
            memory_bytes: 0,
            hit_rate: None,
        })
    }
}

/// Statistics for policy cache monitoring
#[derive(Debug)]
pub struct PolicyCacheStats {
    pub max_entries: usize,
    pub default_ttl: u64,
    pub memory_bytes: usize,
    pub hit_rate: Option<f64>,
}

/// Trait for types that can be converted to/from policy JSON
pub trait PolicySerialize {
    fn to_json(&self) -> Result<String>;
    fn from_json(json: &str) -> Result<Self> where Self: Sized;
}

// Implement for common policy types
impl PolicySerialize for serde_json::Value {
    fn to_json(&self) -> Result<String> {
        Ok(serde_json::to_string(self)?)
    }
    
    fn from_json(json: &str) -> Result<Self> {
        Ok(serde_json::from_str(json)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;
    
    #[tokio::test]
    async fn test_policy_cache_basic() {
        // Skip if Redis is not available in test environment
        let config = crate::client::RedisConfig {
            hosts: "localhost:6379".to_string(),
            password: None,
            ..Default::default()
        };
        
        let redis = Arc::new(crate::client::RedisClientInstance::new(config).await.unwrap());
        let cache = PolicyCache::new(redis);
        
        let key_id = "test-key-123";
        let policy_json = r#"{"allow_consensus":true,"allow_transfer":false}"#;
        
        // Set policy
        cache.set_policy(key_id, policy_json, None).await.unwrap();
        
        // Should be able to retrieve from cache
        let cached = cache.get_policy(key_id).await.unwrap();
        assert!(cached.is_some());
        assert_eq!(cached.unwrap().key_id, key_id);
        
        // Cleanup
        cache.invalidate_policy(key_id).await.unwrap();
    }
    
    #[tokio::test]
    async fn test_policy_get_or_load() {
        let config = crate::client::RedisConfig {
            hosts: "localhost:6379".to_string(),
            password: None,
            ..Default::default()
        };
        
        let redis = Arc::new(crate::client::RedisClientInstance::new(config).await.unwrap());
        let cache = PolicyCache::new(redis);
        
        let key_id = "test-load-key";
        let call_counter = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let call_counter_clone = call_counter.clone();
        
        // First call - should compute and cache
        let loader = || {
            let counter = call_counter_clone.clone();
            async move {
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(r#"{"test":"data"}"#.to_string())
            }
        };
        
        let result1 = cache.get_or_load(key_id, loader).await.unwrap();
        assert!(result1.is_some());
        assert_eq!(call_counter.load(std::sync::atomic::Ordering::SeqCst), 1);
        
        // Second call - should use cache (loader shouldn't be called again)
        let result2 = cache.get_or_load(key_id, loader).await.unwrap();
        assert!(result2.is_some());
        assert_eq!(call_counter.load(std::sync::atomic::Ordering::SeqCst), 1); // Still 1!
        
        assert_eq!(result1.unwrap().to_json(), result2.unwrap().to_json());
        
        // Cleanup
        cache.invalidate_policy(key_id).await.unwrap();
    }
    
    #[tokio::test]
    async fn test_policy_cache_performance() {
        let config = crate::client::RedisConfig {
            hosts: "localhost:6379".to_string(),
            password: None,
            pool_size: 10,
            ..Default::default()
        };
        
        let redis = Arc::new(crate::client::RedisClientInstance::new(config).await.unwrap());
        let cache = PolicyCache::new(Arc::clone(&redis));
        
        // Populate cache with test data
        for i in 0..100 {
            let key_id = format!("perf-test-{}", i);
            let policy = format!(r#"{{"id":{},"name":"test"}}"#, i);
            cache.set_policy(&key_id, &policy, Some(300)).await.unwrap();
        }
        
        // Measure hit performance
        let start = Instant::now();
        for i in 0..1000 {
            let key_id = format!("perf-test-{}", i % 100);
            let _ = cache.get_policy(&key_id).await;
        }
        let elapsed = start.elapsed();
        
        println!("Cache hits: {:.0} ops/sec", 1000.0 / elapsed.as_secs_f64());
        
        // Average should be < 5ms per operation for good cache performance
        assert!(elapsed.as_micros() / 1000 < 500); // Total under 500ms
        
        // Cleanup
        for i in 0..100 {
            let key_id = format!("perf-test-{}", i);
            cache.invalidate_policy(&key_id).await.unwrap();
        }
    }
}
