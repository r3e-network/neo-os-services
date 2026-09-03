//! Error types for the Morpheus relayer

use thiserror::Error;

/// Result type alias for relayer operations
pub type Result<T> = std::result::Result<T, RelayerError>;

/// Relayer error types
#[derive(Debug, Error)]
pub enum RelayerError {
    /// Configuration error
    #[error("configuration error: {0}")]
    Config(String),

    /// Chain interaction error
    #[error("chain error: {0}")]
    Chain(String),

    /// HTTP/Network error
    #[error("network error: {0}")]
    Network(#[from] reqwest::Error),

    /// JSON serialization/deserialization error
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    /// IO error
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    /// Persistence error
    #[error("persistence error: {0}")]
    Persistence(String),

    /// Request processing error
    #[error("request processing error: {0}")]
    Processing(String),

    /// Queue error
    #[error("queue error: {0}")]
    Queue(String),

    /// Invalid state
    #[error("invalid state: {0}")]
    InvalidState(String),

    /// Timeout error
    #[error("operation timed out: {0}")]
    Timeout(String),

    /// Generic error with context
    #[error("{0}")]
    Other(String),
}

impl RelayerError {
    /// Create a configuration error
    pub fn config(msg: impl Into<String>) -> Self {
        Self::Config(msg.into())
    }

    /// Create a chain error
    pub fn chain(msg: impl Into<String>) -> Self {
        Self::Chain(msg.into())
    }

    /// Create a persistence error
    pub fn persistence(msg: impl Into<String>) -> Self {
        Self::Persistence(msg.into())
    }

    /// Create a processing error
    pub fn processing(msg: impl Into<String>) -> Self {
        Self::Processing(msg.into())
    }

    /// Create a queue error
    pub fn queue(msg: impl Into<String>) -> Self {
        Self::Queue(msg.into())
    }

    /// Create an invalid state error
    pub fn invalid_state(msg: impl Into<String>) -> Self {
        Self::InvalidState(msg.into())
    }

    /// Create a timeout error
    pub fn timeout(msg: impl Into<String>) -> Self {
        Self::Timeout(msg.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_display() {
        let err = RelayerError::config("missing network");
        assert_eq!(err.to_string(), "configuration error: missing network");
    }

    #[test]
    fn test_error_conversion() {
        let json_err = serde_json::from_str::<i32>("invalid").unwrap_err();
        let relayer_err: RelayerError = json_err.into();
        assert!(matches!(relayer_err, RelayerError::Json(_)));
    }
}
