//! neo-os-relayer binary entry point (T04).

#[tokio::main]
async fn main() {
    // Initialize tracing / logger
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    if let Err(e) = neo_os_relayer::cli::run_cli().await {
        eprintln!("Error: {e}");
        std::process::exit(1);
    }
}
