//! Retired archive. Not a production crate.
compile_error!(
    "workers/morpheus-relater-rs is a retired archive; use workers/neo-os-relayer"
);

use anyhow::Result;
use tracing::info;

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize logging
    tracing_subscriber::fmt::init();
    
    info!("Morpheus Relayer starting...");
    
    Ok(())
}
