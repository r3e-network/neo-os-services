//! QueryCache - Caches expensive blockchain query results
//! 
//! This cache stores results from RPC calls, blockchain scans, and other
//! expensive read operations. Query results have shorter TTLs as they
//! may become stale more quickly than static data like policies/addresses.

use std::sync::Arc;
use anyhow::{Context, Result};
use redis::prelude::*;
use chrono::Utc;

use crate::client::RedisClientInstance;
use crate::metrics::{self, record_hit, record_miss};

/// Query result entry with metadata
#[derive(Debug, Clone)]
pub struct CachedQuery {
    /// Query result JSON
    pub result_json: String,
    /// Query identifier (hash or name)
    pub query_id: String,
    /// When cached
    pub cached_at: i64,
    /// TTL for this specific query
    pub ttl: u64,
}

impl CachedQuery {
    pub fn new(result_json: &str, query_id: &str, ttl: u64) -> Self {
        Self {
            result_json: result_json.to_string(),
            query_id: query_id.to_string(),
            cached_at: Utc::now().timestamp(),
            ttl,
        }
    }
    
    pub fn to_json(&self) -> Result<String> {
        serde_json::to_string(self).context("Failed to serialize query cache entry")
    }
    
    pub fn from_json(json: &str) -> Result<Self> {
        serde_json::from_str(json).context("Failed to deserialize query cache entry")
    }
}

/// Expensive blockchain query cache
pub struct QueryCache {
    redis: Arc<RedisClientInstance>,
    default_ttl: u64, // Typically 5 minutes for dynamic data
}

impl QueryCache {
    pub fn new(redis: Arc<RedisClientInstance>) -> Self {
        Self {
            redis,
            default_ttl: 300, // 5 minutes - balance between freshness and hit rate
        }
    }
    
    /// Set a custom default TTL
    pub fn with_default_ttl(mut self, ttl: u64) -> Self {
        self.default_ttl = ttl;
        self
    }
    
    /// Execute a query with caching
    /// First tries cache, falls back to executor if not found
    pub async fn get_or_query<F, Fut>(&self, query_key: &str, executor: F) -> Result<String>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<String>>,
    {
        // Try cache first
        match self.redis.get(query_key).await {
            Ok(Some(json)) => {
                record_hit("query");
                
                // Validate TTL
                if let Ok(cached) = CachedQuery::from_json(&json) {
                    let age = Utc::now().timestamp() - cached.cached_at;
                    let age_seconds = age.max(1) as u64;
                    
                    if age_seconds < cached.ttl {
                        tracing::debug!("Query cache HIT: {}", &query_key[..query_key.len().min(20)]);
                        return Ok(cached.result_json);
                    } else {
                        // Expired - remove it
                        self.invalidate(query_key).await.ok();
                    }
                }
            }
            Ok(None) | Err(_) => {
                record_miss("query");
            }
        }
        
        // Cache miss - execute query
        let result = executor().await?;
        
        // Store in cache with default TTL
        let cached = CachedQuery::new(&result, query_key, self.default_ttl);
        let json = cached.to_json()?;
        
        self.redis.set(query_key, &json, Some(self.default_ttl)).await?;
        
        metrics::record_set("query");
        metrics::set_ttl("query", self.default_ttl);
        
        tracing::debug!("Query cache SET for key: {}", &query_key[..query_key.len().min(20)]);
        
        Ok(result)
    }
    
    /// Direct set operation
    pub async fn set(&self, query_key: &str, result_json: &str, ttl: Option<u64>) -> Result<()> {
        let ttl = ttl.unwrap_or(self.default_ttl);
        
        let cached = CachedQuery::new(result_json, query_key, ttl);
        let json = cached.to_json()?;
        
        self.redis.set(query_key, &json, Some(ttl)).await?;
        
        metrics::record_set("query");
        
        Ok(())
    }
    
    /// Invalidate a cached query result
    pub async fn invalidate(&self, query_key: &str) -> Result<bool> {
        let deleted = self.redis.delete(query_key).await? > 0;
        
        if deleted {
            tracing::debug!("Invalidated query cache for key: {}", query_key);
        }
        
        Ok(deleted)
    }
    
    /// Get raw cached value without deserialization
    pub async fn get_raw(&self, query_key: &str) -> Result<Option<String>> {
        self.redis.get(query_key).await
    }
    
    /// Batch invalidate multiple queries
    pub async fn invalidate_batch(&self, keys: &[&str]) -> Result<u64> {
        let mut deleted = 0;
        
        for key in keys {
            if self.invalidate(key).await? {
                deleted += 1;
            }
        }
        
        Ok(deleted)
    }
    
    /// Check if a query is cached
    pub async fn exists(&self, query_key: &str) -> Result<bool> {
        self.redis.exists(query_key).await
    }
    
    /// Flush all cached queries (for testing only!)
    pub async fn flush_all(&self) -> Result<()> {
        self.redis.flush_all().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[tokio::test]
    async fn test_query_cache_basic() {
        let config = crate::client::RedisConfig {
            hosts: "localhost:6379".to_string(),
            password: None,
            ..Default::default()
        };
        
        let redis = Arc::new(crate::client::RedisClientInstance::new(config).await.unwrap());
        let cache = QueryCache::new(redis);
        
        let query_key = "block_height_query";
        let query_result = r#"{"height":1800000,"timestamp":1234567890}"#;
        
        // First call - should execute query
        let result = cache.get_or_query(query_key, || async {
            Ok(query_result.to_string())
        }).await.unwrap();
        
        assert_eq!(result, query_result);
        
        // Second call - should hit cache (query function shouldn't be called)
        let cached_result = cache.get_or_query(query_key, || async {
            panic!("Query should not be re-executed");
        }).await.unwrap();
        
        assert_eq!(cached_result, query_result);
        
        // Cleanup
        cache.invalidate(query_key).await.unwrap();
    }
    
    #[tokio::test]
    async fn test_query_cache_ttl() {
        let config = crate::client::RedisConfig {
            hosts: "localhost:6379".to_string(),
            password: None,
            ..Default::default()
        };
        
        let redis = Arc::new(crate::client::RedisClientInstance::new(config).await.unwrap());
        let cache = QueryCache::new(redis).with_default_ttl(1); // 1 second TTL
        
        let query_key = "ttl_test_query";
        let query_result = r#"{"data":"test"}"#;
        
        // Set with cache
        let _ = cache.get_or_query(query_key, || async {
            Ok(query_result.to_string())
        }).await;
        
        // Should be in cache
        assert!(cache.exists(query_key).await.unwrap());
        
        // Wait for TTL expiration
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
        
        // Should now be expired
        assert!(!cache.exists(query_key).await.unwrap());
        
        // Next access should trigger re-computation
        let fresh_result = cache.get_or_query(query_key, || async {
            Ok(r#"{"data":"fresh"}"#.to_string())
        }).await.unwrap();
        
        assert_eq!(fresh_result, r#"{"data":"fresh"}"#);
    }
}
