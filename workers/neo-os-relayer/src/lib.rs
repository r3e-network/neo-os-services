//! neo-os-relayer — Pure Rust orchestration shell for Neo-OS (T04).
//!
//! Replaces legacy `workers/morpheus-relayer`:
//! - Multi-chain scanning (`neo_n3`, `neox`)
//! - Event deduplication, fulfillment and delivery
//! - Durable queue integration and optimistic concurrency claim
//! - Periodic feed syncing & automation supervision
//! - Cross-chain message (XCM) lane relaying arbitrary messages between N3 and NeoX
//! - Prometheus exposition with 25 byte-identical counters
//! - Full CLI subcommands (`loop`, `once`, `metrics`, `metrics:prom`, `serve:metrics`, `config:validate`, `config:dump`)

pub mod automation;
pub mod cli;
pub mod config;
pub mod config_introspect;
pub mod delivery;
pub mod durable;
pub mod feed_sync;
pub mod fulfillment;
pub mod heartbeat;
pub mod observe;
pub mod relayer;
pub mod scan;
pub mod transport;
pub mod xcm;
pub mod xcm_lane;

pub use config::{create_relayer_config, create_relayer_config_from_env, RelayerConfig};
pub use observe::{render_prometheus_metrics, TOP_LEVEL_COUNTERS};
pub use relayer::{run_relayer_loop, run_relayer_once};
pub use xcm::CrossChainMessage;
pub use xcm_lane::{
    drain_xcm_lane, enqueue_xcm_message, relay_xcm_message, relay_xcm_to_neo_n3,
    relay_xcm_to_neox, XcmDeliveryReceipt, XcmDrainConfig, XcmDrainOutcome,
};
