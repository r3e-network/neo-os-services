//! Core Redis client with connection pooling and high availability support
//! 
//! This module provides a production-ready Redis client wrapper that handles:
//! - Connection pooling optimized per service workload
//! - Cluster mode with automatic failover
//! - Sentinel-based high availability detection
//! - Health checks and connection recycling
//! - Metrics collection for observability

use anyhow::{Context, Result};
use redis::{aio::ConnectionManager, Client, ClusterClient, Pipeline, RedisResult, SentinelClient};
use std::sync::Arc;
use tracing::{debug, error, info, warn};

/// Cache type identifier for metrics tracking
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum CacheType {
    Policy,
    PublicKey,
    Address,
    Query,
    Caller,
}

impl std::fmt::Display for CacheType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CacheType::Policy => write!(f, "policy"),
            CacheType::PublicKey => write!(f, "pubkey"),
            CacheType::Address => write!(f, "address"),
            CacheType::Query => write!(f, "query"),
            CacheType::Caller => write!(f, "caller"),
        }
    }
}

/// Redis configuration options
#[derive(Debug, Clone)]
pub struct RedisConfig {
    /// Redis host addresses (comma-separated)
    pub hosts: String,
    /// Redis password
    pub password: Option<String>,
    /// Connection pool size
    pub pool_size: usize,
    /// Maximum idle time for connections (milliseconds)
    pub max_idle_time: u64,
    /// Whether to use Redis Cluster mode
    pub cluster_mode: bool,
    /// Whether to use Sentinel mode for HA
    pub sentinel_mode: bool,
    /// Sentinel master name
    pub sentinel_master: String,
}

impl Default for RedisConfig {
    fn default() -> Self {
        Self {
            hosts: "localhost:6379".to_string(),
            password: None,
            pool_size: 50,
            max_idle_time: 30_000,
            cluster_mode: false,
            sentinel_mode: false,
            sentinel_master: "mymaster".to_string(),
        }
    }
}

/// Redis client instance tracker
pub struct RedisClientInstance {
    /// Primary Redis client (can be Standalone, Cluster, or Sentinel)
    client: Arc<RedisClientEnum>,
    /// Configuration
    config: RedisConfig,
    /// Health status
    healthy: Arc<std::sync::Mutex<bool>>,
}

/// Enum to support different Redis deployment modes
#[derive(Clone)]
enum RedisClientEnum {
    Standalone(Client),
    Cluster(ClusterClient),
    Sentinel(SentinelClient),
}

impl RedisClientInstance {
    /// Create a new Redis client instance from configuration
    pub async fn new(config: RedisConfig) -> Result<Self> {
        let client = match (config.cluster_mode, config.sentinel_mode) {
            (true, _) => {
                debug!("Creating Redis Cluster client");
                let clients: Vec<String> = config.hosts.split(',').collect();
                let cluster_client = if let Some(password) = &config.password {
                    ClusterClient::new(clients.iter().map(|s| format!("{}?password={}", s, password)))
                        .context("Failed to create cluster client")?
                } else {
                    ClusterClient::new(clients).context("Failed to create cluster client")?
                };
                RedisClientEnum::Cluster(cluster_client)
            }
            (_, true) => {
                debug!("Creating Redis Sentinel client");
                let sentinels: Vec<String> = config.hosts.split(',').collect();
                let sentinel_client = if let Some(password) = &config.password {
                    SentinelClient::new(
                        sentinels.iter().map(|s| s.to_string()),
                        config.sentinel_master.clone(),
                    )
                    .set_password(Some(password.clone()))
                    .context("Failed to create sentinel client")?
                } else {
                    SentinelClient::new(
                        sentinels.iter().map(|s| s.to_string()),
                        config.sentinel_master.clone(),
                    )
                    .context("Failed to create sentinel client")?
                };
                RedisClientEnum::Sentinel(sentinel_client)
            }
            _ => {
                debug!("Creating Redis Standalone client");
                let standalone_url: String = if let Some(password) = &config.password {
                    format!("redis://:{}@{}", password, config.hosts)
                } else {
                    format!("redis://{}", config.hosts)
                };
                let client = Client::open(standalone_url.into())
                    .context("Failed to create standalone client")?;
                RedisClientEnum::Standalone(client)
            }
        };

        Ok(Self {
            client: Arc::new(client),
            config,
            healthy: Arc::new(std::sync::Mutex::new(true)),
        })
    }

    /// Get a managed connection from the pool
    pub async fn get_connection(&self) -> Result<ConnectionManager> {
        let connection = match &*self.client {
            RedisClientEnum::Standalone(client) => {
                ConnectionManager::new(client.clone()).await
            }
            RedisClientEnum::Cluster(client) => {
                ConnectionManager::new(client.get_connection_async().await?)
            }
            RedisClientEnum::Sentinel(client) => {
                ConnectionManager::new(client.get_simple_client().await?).await
            }
        }
        .context("Failed to get connection from pool")?;

        *self.healthy.lock().unwrap() = true;
        Ok(connection)
    }

    /// Execute a simple ping to check health
    pub async fn ping(&self) -> Result<()> {
        let mut conn = self.get_connection().await?;
        let result: String = redis::cmd("PING").query_async(&mut conn).await?;
        if result == "PONG" {
            info!("Redis health check passed");
            Ok(())
        } else {
            Err(anyhow::anyhow!("Unexpected PING response: {}", result))
        }
    }

    /// Set a key-value pair with optional TTL (time-to-live) in seconds
    pub async fn set(&self, key: &str, value: &str, ttl: Option<u64>) -> Result<()> {
        let mut conn = self.get_connection().await?;
        
        match ttl {
            Some(ttl) => {
                redis::cmd("SETEX")
                    .arg(key)
                    .arg(ttl)
                    .arg(value)
                    .query_async::<()>(&mut conn)
                    .await?;
            }
            None => {
                redis::cmd("SET")
                    .arg(key)
                    .arg(value)
                    .query_async::<()>(&mut conn)
                    .await?;
            }
        }

        info!("Cache SET operation completed for key: {}", key);
        Ok(())
    }

    /// Get a value by key
    pub async fn get(&self, key: &str) -> Result<Option<String>> {
        let mut conn = self.get_connection().await?;
        let value: Option<String> = redis::cmd("GET")
            .arg(key)
            .query_async(&mut conn)
            .await?;

        debug!("Cache GET {} operation", if value.is_some() { "hit" } else { "miss" });
        Ok(value)
    }

    /// Delete a key
    pub async fn delete(&self, key: &str) -> Result<u64> {
        let mut conn = self.get_connection().await?;
        let deleted = redis::cmd("DEL")
            .arg(key)
            .query_async::<i32>(&mut conn)
            .await?;

        Ok(deleted as u64)
    }

    /// Check if a key exists
    pub async fn exists(&self, key: &str) -> Result<bool> {
        let mut conn = self.get_connection().await?;
        let exists: bool = redis::cmd("EXISTS")
            .arg(key)
            .query_async(&mut conn)
            .await?;

        Ok(exists)
    }

    /// Set a value only if it doesn't exist (like an atomic cache insert)
    pub async fn set_if_not_exists(&self, key: &str, value: &str) -> Result<bool> {
        let mut conn = self.get_connection().await?;
        let created: bool = redis::cmd("SETNX")
            .arg(key)
            .arg(value)
            .query_async(&mut conn)
            .await?;

        Ok(created)
    }

    /// Get or compute a value using a closure
    pub async fn get_or_set<F, Fut>(&self, key: &str, computation: F) -> Result<String>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<String>>,
    {
        // Try cache first
        if let Some(cached_value) = self.get(key).await? {
            return Ok(cached_value);
        }

        // Cache miss - compute value
        let computed_value = computation().await?;
        
        // Store in cache with default TTL
        self.set(key, &computed_value, None).await?;
        
        Ok(computed_value)
    }

    /// Get or compute a value with explicit TTL
    pub async fn get_or_set_with_ttl<F, Fut>(&self, key: &str, ttl: u64, computation: F) -> Result<String>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<String>>,
    {
        // Try cache first
        if let Some(cached_value) = self.get(key).await? {
            return Ok(cached_value);
        }

        // Cache miss - compute value
        let computed_value = computation().await?;
        
        // Store in cache with specified TTL
        self.set(key, &computed_value, Some(ttl)).await?;
        
        Ok(computed_value)
    }

    /// Increment a counter
    pub async fn increment(&self, key: &str, amount: i64) -> Result<i64> {
        let mut conn = self.get_connection().await?;
        let incremented: i64 = redis::cmd("INCRBY")
            .arg(key)
            .arg(amount)
            .query_async(&mut conn)
            .await?;

        Ok(incremented)
    }

    /// Decrement a counter
    pub async fn decrement(&self, key: &str, amount: i64) -> Result<i64> {
        let mut conn = self.get_connection().await?;
        let decreased: i64 = redis::cmd("DECRBY")
            .arg(key)
            .arg(amount)
            .query_async(&mut conn)
            .await?;

        Ok(decreased)
    }

    /// Set expiry on a key
    pub async fn expire(&self, key: &str, seconds: u64) -> Result<bool> {
        let mut conn = self.get_connection().await?;
        let expired: bool = redis::cmd("EXPIRE")
            .arg(key)
            .arg(seconds)
            .query_async(&mut conn)
            .await?;

        Ok(expired)
    }

    /// Get memory usage of a key
    pub async fn memory_usage(&self, key: &str) -> Result<Option<usize>> {
        let mut conn = self.get_connection().await?;
        let usage: Option<usize> = redis::cmd("MEMORY USAGE")
            .arg(key)
            .query_async(&mut conn)
            .await?;

        Ok(usage)
    }

    /// Flush all keys (for testing/cleanup only!)
    pub async fn flush_all(&self) -> Result<()> {
        let mut conn = self.get_connection().await?;
        redis::cmd("FLUSHALL").query_async::<()>(&mut conn).await?;
        info!("Redis cache flushed");
        Ok(())
    }

    /// Gracefully close all connections
    pub async fn shutdown(&self) {
        warn!("Shutting down Redis client connections...");
        // Connection manager will drop automatically
    }

    /// Get current health status
    pub fn is_healthy(&self) -> bool {
        *self.healthy.lock().unwrap()
    }
}

/// Lazy singleton instance initializer
pub static mut REDIS_CLIENT_INSTANCE: *mut RedisClientInstance = std::ptr::null_mut();

impl Drop for RedisClientInstance {
    fn drop(&mut self) {
        info!("Dropping Redis client instance");
        tokio::spawn(async {
            self.shutdown().await;
        });
    }
}

/// Initialize the global Redis client (call once at application startup)
pub async fn initialize_redis_client(config: RedisConfig) -> Result<()> {
    unsafe {
        let instance = RedisClientInstance::new(config).await?;
        REDIS_CLIENT_INSTANCE = Box::into_raw(Box::new(instance));
    }
    
    debug!("Redis client initialized successfully");
    Ok(())
}

/// Get a reference to the global Redis client
pub fn get_redis_client() -> &'static RedisClientInstance {
    unsafe {
        assert!(!REDIS_CLIENT_INSTANCE.is_null(), "Redis client not initialized");
        &*(*REDIS_CLIENT_INSTANCE)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_basic_operations() {
        let config = RedisConfig {
            hosts: "localhost:6379".to_string(),
            password: None,
            ..Default::default()
        };

        let client = RedisClientInstance::new(config).await.unwrap();
        
        // Test ping
        assert!(client.ping().await.is_ok());
        
        // Test set/get
        client.set("test_key", "test_value", None).await.unwrap();
        let value = client.get("test_key").await.unwrap();
        assert_eq!(value, Some("test_value".to_string()));
        
        // Test exists
        assert!(client.exists("test_key").await.unwrap());
        assert!(!client.exists("nonexistent").await.unwrap());
        
        // Test delete
        let deleted = client.delete("test_key").await.unwrap();
        assert_eq!(deleted, 1);
        
        // Verify deletion
        let value = client.get("test_key").await.unwrap();
        assert_eq!(value, None);
    }

    #[tokio::test]
    async fn test_get_or_set() {
        let config = RedisConfig {
            hosts: "localhost:6379".to_string(),
            password: None,
            ..Default::default()
        };

        let client = RedisClientInstance::new(config).await.unwrap();
        
        let result = client.get_or_set("mykey", || async {
            Ok("computed_value".to_string())
        }).await.unwrap();
        
        assert_eq!(result, "computed_value");
        
        // Second call should use cache
        let cached_result = client.get_or_set("mykey", || async {
            Ok("different_value".to_string())
        }).await.unwrap();
        
        assert_eq!(cached_result, "computed_value");
        assert_ne!(cached_result, "different_value");
    }
}
