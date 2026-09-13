//! Morpheus Relayer Binary

use anyhow::Result;
use tracing::info;

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize logging
    tracing_subscriber::fmt::init();

    info!("Morpheus Relayer starting...");

    Ok(())
}
