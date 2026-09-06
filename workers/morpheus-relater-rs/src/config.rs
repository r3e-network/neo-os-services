//! Configuration module for Morpheus Relayer

use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayerConfig {
    pub network: String,
    pub mode: String,
    pub instance_id: String,
    pub rpc_urls: Vec<String>,
    pub poll_interval_ms: u64,
}

impl RelayerConfig {
    pub fn load() -> Result<Self> {
        // Placeholder - will implement with dotenv and environment variables
        Ok(Self {
            network: "testnet".to_string(),
            mode: "shadow".to_string(),
            instance_id: "default".to_string(),
            rpc_urls: vec![],
            poll_interval_ms: 5000,
        })
    }
}
