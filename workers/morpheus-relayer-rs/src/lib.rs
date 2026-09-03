//! Morpheus Relayer - Rust implementation
//!
//! This crate provides a high-performance Rust implementation of the Morpheus
//! relayer, which processes oracle requests and coordinates with the Nitro
//! worker for fulfillment.
//!
//! ## Architecture
//!
//! The relayer is organized into several modules:
//!
//! - `config`: Configuration management and validation
//! - `chains`: Blockchain interaction (Neo N3, NeoX)
//! - `processor`: Request processing and fulfillment
//! - `queue`: Retry queue and persistence
//! - `automation`: Automation job processing
//! - `feed`: Price feed synchronization
//! - `persistence`: State persistence (Supabase)
//! - `monitoring`: Metrics and logging

pub mod config;
pub mod error;

// Re-exports
pub use error::{RelayerError, Result};

/// Relayer version
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_version() {
        assert!(!VERSION.is_empty());
    }
}
