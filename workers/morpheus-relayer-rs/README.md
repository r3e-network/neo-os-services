# Morpheus Relayer (Rust)

High-performance Rust implementation of the Morpheus Oracle relayer, supporting both Neo N3 and NeoX chains.

## Status

⚠️ **Phase 1 Complete** - Configuration and error handling infrastructure  
🚧 **In Development** - Chain interaction layer (Phase 2)

See [MORPHEUS-RELAYER-RUST-REFACTOR-PLAN.md](../../../MORPHEUS-RELAYER-RUST-REFACTOR-PLAN.md) for the full refactoring roadmap.

## Architecture

This implementation is designed as a **gradual replacement** for the Node.js relayer:

- **Phase 1** (✅ Complete): Configuration and error handling
- **Phase 2** (🚧 Next): Chain interaction (Neo N3 + NeoX RPC clients)
- **Phase 3**: Request processing and queue management
- **Phase 4**: Full replacement with pure Rust binary

## Features

### Multi-Chain Support

- ✅ **Neo N3**: Native support via custom RPC client
- ✅ **NeoX**: EVM-compatible chain support via ethers-rs
- ✅ Concurrent chain monitoring
- ✅ Per-chain configuration

### Current Capabilities

- ✅ Environment-based configuration
- ✅ Network support (mainnet/testnet)
- ✅ Multi-chain architecture
- ✅ Retry configuration
- ✅ Run snapshot management
- ✅ Type-safe error handling
- ✅ Structured logging (tracing)

### Planned Capabilities

- 🚧 Neo N3 block scanning
- 🚧 NeoX event monitoring
- 🚧 Oracle request extraction
- 🚧 Request fulfillment via Nitro worker
- 🚧 Retry queue management
- 🚧 Feed synchronization
- 🚧 Supabase persistence

## Configuration

### Environment Variables

```bash
# Network configuration
MORPHEUS_NETWORK=testnet                    # mainnet or testnet
MORPHEUS_ACTIVE_CHAINS=neo_n3,neox         # Comma-separated chain list
MORPHEUS_MODE=full                          # full, requests_only, or feed_only

# Nitro worker
MORPHEUS_NITRO_ENDPOINT=http://localhost:8080

# Timeouts (milliseconds)
MORPHEUS_REQUEST_TIMEOUT_MS=10000
MORPHEUS_FEED_SYNC_TIMEOUT_MS=30000
```

### Supported Chains

| Chain | Identifier | Status |
|-------|-----------|--------|
| Neo N3 | `neo_n3` | ✅ Supported |
| NeoX | `neox` | ✅ Supported |

### Operation Modes

- **`full`** (default): Process oracle requests + feed sync
- **`requests_only`**: Process only oracle requests
- **`feed_only`**: Process only feed synchronization

## Usage

### As a Library

```rust
use morpheus_relayer_rs::{config::RelayerConfig, Result};

#[tokio::main]
async fn main() -> Result<()> {
    let config = RelayerConfig::from_env()?;
    config.validate()?;
    
    println!("Active chains: {:?}", config.active_chains);
    println!("Network: {:?}", config.network);
    
    Ok(())
}
```

### Running Tests

```bash
cargo test
```

### Building

```bash
# Development build
cargo build

# Release build (optimized)
cargo build --release
```

## Performance Goals

| Metric | Node.js (Current) | Rust (Target) | Status |
|--------|------------------|---------------|--------|
| Latency | ~150ms | <50ms | 🚧 |
| Throughput | ~300 req/s | >1000 req/s | 🚧 |
| Memory | ~300MB | <100MB | 🚧 |
| Startup | ~5s | <1s | ✅ <1s |
| Image Size | ~200MB | <50MB | 🚧 |

## Development

### Project Structure

```
morpheus-relayer-rs/
├── src/
│   ├── lib.rs              # Library root
│   ├── error.rs            # Error types (✅)
│   ├── config.rs           # Configuration (✅)
│   ├── chains/             # Chain interaction (🚧)
│   │   ├── neo_n3.rs
│   │   └── neox.rs
│   ├── processor/          # Request processing (⏳)
│   ├── queue/              # Queue management (⏳)
│   └── monitoring/         # Metrics and logging (⏳)
├── Cargo.toml
└── README.md
```

### Adding a New Chain

1. Add chain enum variant in `config.rs`:
```rust
pub enum Chain {
    NeoN3,
    NeoX,
    YourChain,  // Add here
}
```

2. Implement chain client in `src/chains/your_chain.rs`
3. Register in `MORPHEUS_ACTIVE_CHAINS` environment variable

### Testing

```bash
# Run all tests
cargo test

# Run specific test
cargo test test_config_validation

# Run with output
cargo test -- --nocapture
```

## Migration Strategy

This Rust implementation coexists with the Node.js relayer during migration:

1. **Phase 1** (Current): Core infrastructure - can be imported as library
2. **Phase 2**: Chain layer - FFI bridge to Node.js OR standalone mode
3. **Phase 3**: Request processing - hybrid deployment
4. **Phase 4**: Full replacement - retire Node.js version

## Compatibility

- **Rust Version**: 1.75+
- **Node.js Integration**: Optional via napi-rs (Phase 2+)
- **Platforms**: Linux, macOS, Windows

## Related Projects

- [neo-signer](../neo-signer/) - Signature service with TEE support
- [nitro-enclave-host](../nitro-enclave-host/) - Nitro enclave orchestration
- [morpheus-relayer](../morpheus-relayer/) - Node.js implementation (legacy)

## License

MIT
