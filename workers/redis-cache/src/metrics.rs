//! Prometheus metrics for Redis caching layer
//! 
//! Tracks:
//! - Cache hits/misses by type (policy, pubkey, address, query)
//! - Hit rate percentages
//! - Memory usage per key type
//! - Eviction statistics
//! - Latency percentiles

use std::sync::OnceLock;
use tracing::{debug, error};

/// Cached metrics instances
static CACHE_HITS_TOTAL: OnceLock<prometheus::IntCounterVec> = OnceLock::new();
static CACHE_MISSES_TOTAL: OnceLock<prometheus::IntCounterVec> = OnceLock::new();
static CACHE_HIT_RATE: OnceLock<prometheus::GaugeVec> = OnceLock::new();
static CACHE_MEMORY_USAGE: OnceLock<prometheus::GaugeVec> = OnceLock::new();
static CACHE_EVICTIONS_TOTAL: OnceLock<prometheus::IntCounterVec> = OnceLock::new();
static CACHE_TTL_SECONDS: OnceLock<prometheus::GaugeVec> = OnceLock::new();
static CACHE_SET_COUNT: OnceLock<prometheus::IntCounterVec> = OnceLock::new();
static CACHE_GET_LATENCY_MS: OnceLock<prometheus::HistogramVec> = OnceLock::new();

/// Initialize all Prometheus metrics collectors
pub fn init_metrics() {
    // Track total cache hits by cache type
    let hits = prometheus::IntCounterVec::new(
        prometheus::Opts::new(
            "redis_cache_hits_total",
            "Total number of cache hits",
        ),
        &["type"],
    ).expect("Failed to create redis_cache_hits_total metric");

    prometheus::register(Box::new(hits.clone())).unwrap();
    CACHE_HITS_TOTAL.set(hits).unwrap();

    // Track total cache misses by cache type
    let misses = prometheus::IntCounterVec::new(
        prometheus::Opts::new(
            "redis_cache_misses_total",
            "Total number of cache misses",
        ),
        &["type"],
    ).expect("Failed to create redis_cache_misses_total metric");

    prometheus::register(Box::new(misses.clone())).unwrap();
    CACHE_MISSES_TOTAL.set(misses).unwrap();

    // Track current hit rate as a gauge (computed value)
    let hit_rate = prometheus::GaugeVec::new(
        prometheus::Opts::new(
            "redis_cache_hit_rate_percent",
            "Current cache hit rate percentage",
        ),
        &["type"],
    ).expect("Failed to create redis_cache_hit_rate_percent metric");

    prometheus::register(Box::new(hit_rate.clone())).unwrap();
    CACHE_HIT_RATE.set(hit_rate).unwrap();

    // Track memory usage per cache type
    let memory_usage = prometheus::GaugeVec::new(
        prometheus::Opts::new(
            "redis_memory_used_bytes",
            "Memory usage in bytes",
        ),
        &["type"],
    ).expect("Failed to create redis_memory_used_bytes metric");

    prometheus::register(Box::new(memory_usage.clone())).unwrap();
    CACHE_MEMORY_USAGE.set(memory_usage).unwrap();

    // Track total evictions per cache type
    let evictions = prometheus::IntCounterVec::new(
        prometheus::Opts::new(
            "redis_evicted_keys_total",
            "Total number of evicted keys due to memory pressure",
        ),
        &["type"],
    ).expect("Failed to create redis_evicted_keys_total metric");

    prometheus::register(Box::new(evictions.clone())).unwrap();
    CACHE_EVICTIONS_TOTAL.set(evictions).unwrap();

    // Track TTL values currently set
    let ttl_seconds = prometheus::GaugeVec::new(
        prometheus::Opts::new(
            "redis_cache_ttl_seconds",
            "TTL time-to-live in seconds for cached items",
        ),
        &["type"],
    ).expect("Failed to create redis_cache_ttl_seconds metric");

    prometheus::register(Box::new(ttl_seconds.clone())).unwrap();
    CACHE_TTL_SECONDS.set(ttl_seconds).unwrap();

    // Track SET operations count
    let set_count = prometheus::IntCounterVec::new(
        prometheus::Opts::new(
            "redis_cache_sets_total",
            "Total number of SET operations",
        ),
        &["type"],
    ).expect("Failed to create redis_cache_sets_total metric");

    prometheus::register(Box::new(set_count.clone())).unwrap();
    CACHE_SET_COUNT.set(set_count).unwrap();

    // Track GET operation latency in milliseconds
    let get_latency = prometheus::HistogramVec::new(
        prometheus::HistogramOpts::new(
            "redis_cache_get_latency_ms",
            "Time taken to perform GET operations",
        )
        ._buckets(vec![0.1, 0.5, 1.0, 2.5, 5.0, 10.0, 25.0, 50.0, 100.0, 250.0, 500.0])
    ).expect("Failed to create redis_cache_get_latency_ms metric");

    prometheus::register(Box::new(get_latency.clone())).unwrap();
    CACHE_GET_LATENCY_MS.set(get_latency).unwrap();

    debug!("Redis cache metrics initialized successfully");
}

/// Record a cache hit for a specific cache type
pub fn record_hit(cache_type: &str) {
    if let Some(counter) = CACHE_HITS_TOTAL.get() {
        counter.with_label_values(&[cache_type]).inc();
    } else {
        error!("Cache metrics not initialized");
    }
}

/// Record a cache miss for a specific cache type
pub fn record_miss(cache_type: &str) {
    if let Some(counter) = CACHE_MISSES_TOTAL.get() {
        counter.with_label_values(&[cache_type]).inc();
    } else {
        error!("Cache metrics not initialized");
    }
}

/// Update the calculated hit rate for a cache type
/// Note: This should be called periodically to maintain accurate hit rate
pub fn update_hit_rate(cache_type: &str, hit_rate: f64) {
    if let Some(gauge) = CACHE_HIT_RATE.get() {
        gauge
            .with_label_values(&[cache_type])
            .set(hit_rate);
    }
}

/// Set memory usage for a cache type
pub fn set_memory_usage(cache_type: &str, bytes: usize) {
    if let Some(gauge) = CACHE_MEMORY_USAGE.get() {
        gauge.with_label_values(&[cache_type]).set(bytes as f64);
    }
}

/// Record an eviction event
pub fn record_eviction(cache_type: &str) {
    if let Some(counter) = CACHE_EVICTIONS_TOTAL.get() {
        counter.with_label_values(&[cache_type]).inc();
    } else {
        error!("Cache metrics not initialized");
    }
}

/// Set TTL value for a cache type
pub fn set_ttl(cache_type: &str, ttl_seconds: u64) {
    if let Some(gauge) = CACHE_TTL_SECONDS.get() {
        gauge.with_label_values(&[cache_type]).set(ttl_seconds as f64);
    }
}

/// Record a cache set operation
pub fn record_set(cache_type: &str) {
    if let Some(counter) = CACHE_SET_COUNT.get() {
        counter.with_label_values(&[cache_type]).inc();
    }
}

/// Record GET operation latency in milliseconds
pub fn record_get_latency(cache_type: &str, latency_ms: f64) {
    if let Some(histogram) = CACHE_GET_LATENCY_MS.get() {
        histogram
            .with_label_values(&[cache_type])
            .observe(latency_ms);
    }
}

/// Calculate and return current hit rate based on last recorded hits and misses
/// Returns None if no data has been recorded yet
pub fn calculate_hit_rate(cache_type: &str) -> Option<f64> {
    let hits_total = CACHE_HITS_TOTAL.get()?;
    let misses_total = CACHE_MISSES_TOTAL.get()?;

    let hits = hits_total.with_label_values(&[cache_type]).get();
    let misses = misses_total.with_label_values(&[cache_type]).get();

    let total = hits + misses;
    if total == 0 {
        None
    } else {
        Some((hits as f64 / total as f64) * 100.0)
    }
}

/// Get comprehensive cache statistics
pub struct CacheStats {
    pub hits_total: u64,
    pub misses_total: u64,
    pub hit_rate: Option<f64>,
    pub sets_total: u64,
    pub memory_usage_bytes: usize,
}

impl CacheStats {
    pub fn new(cache_type: &str) -> Option<Self> {
        let hits_total = CACHE_HITS_TOTAL.get()?.with_label_values(&[cache_type]).get();
        let misses_total = CACHE_MISSES_TOTAL.get()?.with_label_values(&[cache_type]).get();
        let hit_rate = Some((hits_total as f64 / (hits_total + misses_total) as f64) * 100.0);
        
        Some(CacheStats {
            hits_total,
            misses_total,
            hit_rate,
            sets_total: CACHE_SET_COUNT.get()?.with_label_values(&[cache_type]).get(),
            memory_usage_bytes: 0, // Would need additional query to Redis
        })
    }
}

/// Periodically compute and update hit rates (call from background task)
pub async fn run_hit_rate_tracker() {
    use tokio::time::{sleep, Duration};
    
    loop {
        sleep(Duration::from_secs(1)).await;
        
        let types = ["policy", "pubkey", "address", "query"];
        
        for cache_type in types.iter() {
            if let Some(rate) = calculate_hit_rate(*cache_type) {
                update_hit_rate(*cache_type, rate);
                
                debug!(
                    "Cache hit rate for {}: {:.2}%",
                    cache_type,
                    rate
                );
            }
        }
    }
}

/// Export all metrics as text for Prometheus scraping
pub fn gather_metrics_text() -> String {
    use prometheus::Encoder;
    
    let registry = prometheus::Registry::new();
    
    // Re-register existing collectors
    let _ = CACHE_HITS_TOTAL.get().map(|c| {
        registry.register(Box::new(c.clone())).ok();
    });
    let _ = CACHE_MISSES_TOTAL.get().map(|c| {
        registry.register(Box::new(c.clone())).ok();
    });
    let _ = CACHE_HIT_RATE.get().map(|c| {
        registry.register(Box::new(c.clone())).ok();
    });
    
    let encoder = prometheus::TextEncoder::new();
    let mut buffer = Vec::new();
    
    if let Ok(metrics) = encoder.encode(&registry.gather(), &mut buffer) {
        String::from_utf8(buffer).unwrap_or_default()
    } else {
        String::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_metrics_initialization() {
        init_metrics();
        
        assert!(CACHE_HITS_TOTAL.get().is_some());
        assert!(CACHE_MISSES_TOTAL.get().is_some());
        assert!(CACHE_HIT_RATE.get().is_some());
    }

    #[test]
    fn test_hit_miss_recording() {
        init_metrics();
        
        record_hit("policy");
        record_hit("policy");
        record_miss("policy");
        
        let stats = CacheStats::new("policy").unwrap();
        assert_eq!(stats.hits_total, 2);
        assert_eq!(stats.misses_total, 1);
        assert!((stats.hit_rate.unwrap() - 66.67).abs() < 0.01);
    }

    #[test]
    fn test_latency_recording() {
        init_metrics();
        
        record_get_latency("policy", 1.5);
        record_get_latency("policy", 2.3);
        record_get_latency("policy", 10.0);
        
        // Metrics are recorded even without reading them back in this simple test
    }
}
