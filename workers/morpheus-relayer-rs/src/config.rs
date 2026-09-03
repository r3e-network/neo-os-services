//! Configuration management for the Morpheus relayer
//!
//! This module handles loading and validation of relayer configuration from
//! environment variables, matching the Node.js implementation's behavior.

use crate::error::{RelayerError, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Supported blockchain networks
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Network {
    Mainnet,
    Testnet,
}

impl Network {
    /// Parse network from string (case-insensitive)
    pub fn parse(s: &str) -> Result<Self> {
        match s.trim().to_lowercase().as_str() {
            "mainnet" => Ok(Self::Mainnet),
            "testnet" => Ok(Self::Testnet),
            _ => Err(RelayerError::config(format!("invalid network: {}", s))),
        }
    }

    /// Convert to string representation
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Mainnet => "mainnet",
            Self::Testnet => "testnet",
        }
    }
}

/// Supported blockchain chains
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Chain {
    NeoN3,
    NeoX,
}

impl Chain {
    /// Parse chain from string (case-insensitive)
    pub fn parse(s: &str) -> Result<Self> {
        match s.trim().to_lowercase().as_str() {
            "neo_n3" | "neo-n3" | "neon3" => Ok(Self::NeoN3),
            "neox" | "neo-x" => Ok(Self::NeoX),
            _ => Err(RelayerError::config(format!("invalid chain: {}", s))),
        }
    }

    /// Convert to string representation
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::NeoN3 => "neo_n3",
            Self::NeoX => "neox",
        }
    }
}

/// Relayer operation mode
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RelayerMode {
    /// Process both oracle requests and feed sync
    Full,
    /// Process only oracle requests
    RequestsOnly,
    /// Process only feed sync
    FeedOnly,
}

impl Default for RelayerMode {
    fn default() -> Self {
        Self::Full
    }
}

impl RelayerMode {
    /// Parse mode from string
    pub fn parse(s: &str) -> Result<Self> {
        match s.trim().to_lowercase().as_str() {
            "full" | "" => Ok(Self::Full),
            "requests_only" => Ok(Self::RequestsOnly),
            "feed_only" => Ok(Self::FeedOnly),
            _ => Err(RelayerError::config(format!("invalid mode: {}", s))),
        }
    }
}

/// Network-specific configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkConfig {
    /// RPC URLs for this network
    pub rpc_urls: Vec<String>,
    /// Oracle contract address
    pub oracle_contract: String,
}

/// Chain-specific configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChainConfig {
    /// Mainnet configuration
    pub mainnet: NetworkConfig,
    /// Testnet configuration
    pub testnet: NetworkConfig,
}

/// Retry queue configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetryConfig {
    /// Maximum number of retries
    #[serde(default = "default_max_retries")]
    pub max_retries: u32,
    /// Initial backoff delay in milliseconds
    #[serde(default = "default_initial_delay_ms")]
    pub initial_delay_ms: u64,
    /// Maximum backoff delay in milliseconds
    #[serde(default = "default_max_delay_ms")]
    pub max_delay_ms: u64,
}

fn default_max_retries() -> u32 {
    5
}

fn default_initial_delay_ms() -> u64 {
    1000
}

fn default_max_delay_ms() -> u64 {
    10_000
}

impl Default for RetryConfig {
    fn default() -> Self {
        Self {
            max_retries: default_max_retries(),
            initial_delay_ms: default_initial_delay_ms(),
            max_delay_ms: default_max_delay_ms(),
        }
    }
}

/// Run snapshot persistence configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunSnapshotConfig {
    /// Whether to persist run snapshots
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Interval between snapshots in milliseconds
    #[serde(default = "default_snapshot_interval_ms")]
    pub interval_ms: u64,
    /// Error backoff period in milliseconds
    #[serde(default = "default_error_backoff_ms")]
    pub error_backoff_ms: u64,
}

fn default_true() -> bool {
    true
}

fn default_snapshot_interval_ms() -> u64 {
    60_000 // 1 minute
}

fn default_error_backoff_ms() -> u64 {
    300_000 // 5 minutes
}

impl Default for RunSnapshotConfig {
    fn default() -> Self {
        Self {
            enabled: default_true(),
            interval_ms: default_snapshot_interval_ms(),
            error_backoff_ms: default_error_backoff_ms(),
        }
    }
}

/// Main relayer configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayerConfig {
    /// Network (mainnet/testnet)
    pub network: Network,
    /// Active chains to monitor
    pub active_chains: Vec<Chain>,
    /// Relayer operation mode
    pub mode: RelayerMode,
    /// Chain-specific configurations
    pub chains: HashMap<Chain, ChainConfig>,
    /// Retry configuration
    #[serde(default)]
    pub retry: RetryConfig,
    /// Run snapshot configuration
    #[serde(default)]
    pub run_snapshots: RunSnapshotConfig,
    /// Nitro worker endpoint
    pub nitro_endpoint: String,
    /// Request timeout in milliseconds
    #[serde(default = "default_request_timeout_ms")]
    pub request_timeout_ms: u64,
    /// Feed sync timeout in milliseconds
    #[serde(default = "default_feed_sync_timeout_ms")]
    pub feed_sync_timeout_ms: u64,
}

fn default_request_timeout_ms() -> u64 {
    10_000
}

fn default_feed_sync_timeout_ms() -> u64 {
    30_000
}

impl RelayerConfig {
    /// Load configuration from environment variables
    pub fn from_env() -> Result<Self> {
        let network = env_var("MORPHEUS_NETWORK")
            .and_then(|s| Network::parse(&s).ok())
            .unwrap_or(Network::Testnet);

        let active_chains = env_var("MORPHEUS_ACTIVE_CHAINS")
            .map(|s| parse_chain_list(&s))
            .unwrap_or_else(|| vec![Chain::NeoN3]);

        let mode = env_var("MORPHEUS_MODE")
            .and_then(|s| RelayerMode::parse(&s).ok())
            .unwrap_or_default();

        let nitro_endpoint = env_var("MORPHEUS_NITRO_ENDPOINT")
            .or_else(|| env_var("NITRO_ENDPOINT"))
            .unwrap_or_else(|| "http://localhost:8080".to_string());

        let request_timeout_ms = env_var("MORPHEUS_REQUEST_TIMEOUT_MS")
            .and_then(|s| s.parse().ok())
            .unwrap_or_else(default_request_timeout_ms);

        let feed_sync_timeout_ms = env_var("MORPHEUS_FEED_SYNC_TIMEOUT_MS")
            .and_then(|s| s.parse().ok())
            .unwrap_or_else(default_feed_sync_timeout_ms);

        Ok(Self {
            network,
            active_chains,
            mode,
            chains: HashMap::new(), // TODO: Load from config files
            retry: RetryConfig::default(),
            run_snapshots: RunSnapshotConfig::default(),
            nitro_endpoint,
            request_timeout_ms,
            feed_sync_timeout_ms,
        })
    }

    /// Validate configuration
    pub fn validate(&self) -> Result<()> {
        if self.active_chains.is_empty() {
            return Err(RelayerError::config("no active chains configured"));
        }

        if self.nitro_endpoint.is_empty() {
            return Err(RelayerError::config("nitro endpoint is required"));
        }

        if self.request_timeout_ms == 0 {
            return Err(RelayerError::config(
                "request timeout must be greater than 0",
            ));
        }

        Ok(())
    }

    /// Check if a chain is active
    pub fn is_chain_active(&self, chain: Chain) -> bool {
        self.active_chains.contains(&chain)
    }

    /// Check if feed sync should run
    pub fn should_run_feed_sync(&self) -> bool {
        !matches!(self.mode, RelayerMode::RequestsOnly)
    }

    /// Check if request processing should run
    pub fn should_run_request_processing(&self) -> bool {
        !matches!(self.mode, RelayerMode::FeedOnly)
    }
}

/// Get environment variable
fn env_var(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|s| !s.trim().is_empty())
}

/// Parse comma-separated chain list
fn parse_chain_list(s: &str) -> Vec<Chain> {
    s.split(',')
        .filter_map(|part| Chain::parse(part.trim()).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_network_parse() {
        assert_eq!(Network::parse("mainnet").unwrap(), Network::Mainnet);
        assert_eq!(Network::parse("TESTNET").unwrap(), Network::Testnet);
        assert_eq!(Network::parse(" testnet ").unwrap(), Network::Testnet);
        assert!(Network::parse("invalid").is_err());
    }

    #[test]
    fn test_chain_parse() {
        assert_eq!(Chain::parse("neo_n3").unwrap(), Chain::NeoN3);
        assert_eq!(Chain::parse("NEO-N3").unwrap(), Chain::NeoN3);
        assert_eq!(Chain::parse("neox").unwrap(), Chain::NeoX);
        assert!(Chain::parse("invalid").is_err());
    }

    #[test]
    fn test_mode_parse() {
        assert_eq!(RelayerMode::parse("full").unwrap(), RelayerMode::Full);
        assert_eq!(
            RelayerMode::parse("requests_only").unwrap(),
            RelayerMode::RequestsOnly
        );
        assert_eq!(
            RelayerMode::parse("feed_only").unwrap(),
            RelayerMode::FeedOnly
        );
        assert!(RelayerMode::parse("invalid").is_err());
    }

    #[test]
    fn test_parse_chain_list() {
        let chains = parse_chain_list("neo_n3,neox");
        assert_eq!(chains.len(), 2);
        assert!(chains.contains(&Chain::NeoN3));
        assert!(chains.contains(&Chain::NeoX));
    }

    #[test]
    fn test_config_defaults() {
        let retry = RetryConfig::default();
        assert_eq!(retry.max_retries, 5);
        assert_eq!(retry.initial_delay_ms, 1000);
        assert_eq!(retry.max_delay_ms, 10_000);
    }

    #[test]
    fn test_config_validation() {
        let mut config = RelayerConfig {
            network: Network::Testnet,
            active_chains: vec![Chain::NeoN3],
            mode: RelayerMode::Full,
            chains: HashMap::new(),
            retry: RetryConfig::default(),
            run_snapshots: RunSnapshotConfig::default(),
            nitro_endpoint: "http://localhost:8080".to_string(),
            request_timeout_ms: 10_000,
            feed_sync_timeout_ms: 30_000,
        };

        assert!(config.validate().is_ok());

        config.active_chains.clear();
        assert!(config.validate().is_err());
    }
}
