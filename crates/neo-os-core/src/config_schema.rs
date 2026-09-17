//! Declarative manifest of every environment variable the relayer's
//! `createRelayerConfig()` reads (port of
//! workers/morpheus-relayer/src/config-schema.js).
//!
//! The JS manifest exists so operators can (a) see the RESOLVED configuration,
//! (b) learn which alias actually won, and (c) catch a typo'd MORPHEUS_*/NITRO_*
//! variable instead of silently running on defaults. It does NOT participate in
//! runtime resolution — it is an additive, read-only description of that
//! resolution, and config-schema.test.mjs on the JS side asserts the manifest
//! cannot quietly rot away from the resolver it documents.
//!
//! TRUTHFULNESS: each entry's `aliases` list is the SAME ordered alias list
//! passed to the corresponding `env(...)` call in config.js; the order is the
//! precedence order (process.env first across ALL aliases, then the packed
//! MORPHEUS_RUNTIME_CONFIG_JSON object). The static table below is GENERATED
//! from the JS oracle by scripts/gen-config-schema-rust.mjs — do not hand-edit;
//! regenerate instead.

use crate::secret_redaction;

/// A single logical setting: stable dot-path key, ordered env aliases
/// (precedence order), human description of the fallback, and flags.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigSetting {
    /// Stable logical name (dot-path mirrors the config object shape).
    pub key: &'static str,
    /// Ordered env var names, exactly as passed to env(...) in config.js.
    pub aliases: &'static [&'static str],
    /// Human description of the fallback when no alias is set.
    pub default: &'static str,
    /// True => validate fails if no alias resolves to a value.
    pub required: bool,
    /// True => value is redacted in dump (overrides name-based detection).
    pub secret: bool,
    /// One-liner description.
    pub description: &'static str,
}

/// Direct-control env keys consumed outside env() alias chains
/// (JS direct controls plus Rust-only controls owned by this generator).
pub static DIRECT_CONTROL_ENV_KEYS: &[&str] = &[
    "MORPHEUS_RUNTIME_CONFIG_JSON",
    "MORPHEUS_NETWORK",
    "NEXT_PUBLIC_MORPHEUS_NETWORK",
    "MORPHEUS_ALLOW_UNAVAILABLE_AUTOMATION",
    "MORPHEUS_DELIVERY_PROTOCOL",
    "MORPHEUS_N3_RECONCILIATION_ARCHIVE_RPC_URLS",
    "MORPHEUS_ALLOW_LEGACY_LOCAL",
];

/// Declarative manifest of every env var createRelayerConfig() reads
/// (port of config-schema.js CONFIG_SCHEMA — generated, do not hand-edit).
pub static CONFIG_SCHEMA: &[ConfigSetting] = &[
    ConfigSetting {
        key: "network",
        aliases: &["MORPHEUS_NETWORK", "NEXT_PUBLIC_MORPHEUS_NETWORK"],
        default: "testnet",
        required: false,
        secret: false,
        description: "Target network (mainnet|testnet); selects registry + RPC defaults.",
    },
    ConfigSetting {
        key: "mode",
        aliases: &["MORPHEUS_RELAYER_MODE"],
        default: "combined",
        required: false,
        secret: false,
        description: "Relayer mode: combined | feed_only | requests_only.",
    },
    ConfigSetting {
        key: "useDerivedKeys",
        aliases: &["NITRO_USE_DERIVED_KEYS"],
        default: "false",
        required: false,
        secret: false,
        description: "Relayed to runtime API calls (useDerivedKeys payload flag) for in-enclave derived-key lanes. Relayer Neo N3 signing no longer uses derived keys — it always goes through the custody signer service.",
    },
    ConfigSetting {
        key: "instanceId",
        aliases: &["MORPHEUS_RELAYER_INSTANCE_ID"],
        default: "derived: <mode>:<network>:<hostname>:<pid>",
        required: false,
        secret: false,
        description: "Stable instance identifier for cross-instance durable-queue claims.",
    },
    ConfigSetting {
        key: "activeChains",
        aliases: &["MORPHEUS_ACTIVE_CHAINS"],
        default: "neo_n3",
        required: false,
        secret: false,
        description: "Comma list of active chains (subset of neo_n3,neox).",
    },
    ConfigSetting {
        key: "pollIntervalMs",
        aliases: &["MORPHEUS_RELAYER_POLL_INTERVAL_MS"],
        default: "5000",
        required: false,
        secret: false,
        description: "Main loop poll interval (ms).",
    },
    ConfigSetting {
        key: "concurrency",
        aliases: &["MORPHEUS_RELAYER_CONCURRENCY"],
        default: "4",
        required: false,
        secret: false,
        description: "Max concurrent request processors (min 1).",
    },
    ConfigSetting {
        key: "maxBlocksPerTick",
        aliases: &["MORPHEUS_RELAYER_MAX_BLOCKS_PER_TICK"],
        default: "250",
        required: false,
        secret: false,
        description: "Max blocks scanned per tick (min 1).",
    },
    ConfigSetting {
        key: "maxRetries",
        aliases: &["MORPHEUS_RELAYER_MAX_RETRIES"],
        default: "5",
        required: false,
        secret: false,
        description: "Max processing retries before dead-letter (min 0).",
    },
    ConfigSetting {
        key: "maxCallbackRetries",
        aliases: &["MORPHEUS_RELAYER_MAX_CALLBACK_RETRIES"],
        default: "maxRetries * 2",
        required: false,
        secret: false,
        description: "Max callback-delivery / failure-finalize redelivery attempts (min 1).",
    },
    ConfigSetting {
        key: "retryBaseDelayMs",
        aliases: &["MORPHEUS_RELAYER_RETRY_BASE_DELAY_MS"],
        default: "5000",
        required: false,
        secret: false,
        description: "Base retry backoff delay (ms, min 250).",
    },
    ConfigSetting {
        key: "retryMaxDelayMs",
        aliases: &["MORPHEUS_RELAYER_RETRY_MAX_DELAY_MS"],
        default: "10000",
        required: false,
        secret: false,
        description: "Retry backoff cap (ms, clamped 1000..600000).",
    },
    ConfigSetting {
        key: "statePersistMinIntervalMs",
        aliases: &["MORPHEUS_RELAYER_STATE_PERSIST_MIN_INTERVAL_MS"],
        default: "250",
        required: false,
        secret: false,
        description: "Min interval between local state-file writes (ms; 0 = write on every call).",
    },
    ConfigSetting {
        key: "processedCacheSize",
        aliases: &["MORPHEUS_RELAYER_PROCESSED_CACHE_SIZE"],
        default: "5000",
        required: false,
        secret: false,
        description: "Processed-request de-dup cache size (min 100).",
    },
    ConfigSetting {
        key: "deadLetterLimit",
        aliases: &["MORPHEUS_RELAYER_DEAD_LETTER_LIMIT"],
        default: "500",
        required: false,
        secret: false,
        description: "Max retained dead-letter entries (min 10).",
    },
    ConfigSetting {
        key: "retryQueueLimit",
        aliases: &["MORPHEUS_RELAYER_RETRY_QUEUE_LIMIT"],
        default: "0",
        required: false,
        secret: false,
        description: "In-memory retry-queue ceiling per chain (0 = unbounded).",
    },
    ConfigSetting {
        key: "stateFile",
        aliases: &["MORPHEUS_RELAYER_STATE_FILE"],
        default: "derived: .morpheus-relayer-state[.<mode>].json",
        required: false,
        secret: false,
        description: "Local state-file path (relative to repo root unless absolute).",
    },
    ConfigSetting {
        key: "supabaseUrl",
        aliases: &["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "morpheus_SUPABASE_URL"],
        default: "(unset)",
        required: false,
        secret: false,
        description: "Supabase URL; presence enables the durable queue by default.",
    },
    ConfigSetting {
        key: "supabaseKey",
        aliases: &["SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY", "morpheus_SUPABASE_SECRET_KEY", "morpheus_SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_KEY"],
        default: "(unset)",
        required: false,
        secret: true,
        description: "Supabase service key; presence enables the durable queue by default.",
    },
    ConfigSetting {
        key: "durableQueue.enabled",
        aliases: &["MORPHEUS_DURABLE_QUEUE_ENABLED"],
        default: "true when both Supabase URL + key are set",
        required: false,
        secret: false,
        description: "Force durable cross-instance queue on/off.",
    },
    ConfigSetting {
        key: "durableQueue.failClosed",
        aliases: &["MORPHEUS_DURABLE_QUEUE_FAIL_CLOSED"],
        default: "mirrors durableQueue.enabled",
        required: false,
        secret: false,
        description: "Fail closed (skip processing) when the durable queue is unreachable.",
    },
    ConfigSetting {
        key: "durableQueue.allowLocalClaimDuringBackoff",
        aliases: &["MORPHEUS_DURABLE_QUEUE_ALLOW_LOCAL_CLAIM_DURING_BACKOFF"],
        default: "false",
        required: false,
        secret: false,
        description: "Allow local claim while the shared idempotency store is in backoff (single-instance only; ignored in production).",
    },
    ConfigSetting {
        key: "durableQueue.syncLimit",
        aliases: &["MORPHEUS_DURABLE_QUEUE_SYNC_LIMIT"],
        default: "200",
        required: false,
        secret: false,
        description: "Durable-queue sync batch size (min 1).",
    },
    ConfigSetting {
        key: "durableQueue.staleProcessingMs",
        aliases: &["MORPHEUS_DURABLE_QUEUE_STALE_PROCESSING_MS"],
        default: "45000",
        required: false,
        secret: false,
        description: "Age after which an in-progress durable claim is considered stale (ms, min 1000).",
    },
    ConfigSetting {
        key: "runSnapshots.enabled",
        aliases: &["MORPHEUS_RELAYER_RUN_SNAPSHOTS_ENABLED"],
        default: "true",
        required: false,
        secret: false,
        description: "Periodic run-snapshot persistence on/off.",
    },
    ConfigSetting {
        key: "runSnapshots.intervalMs",
        aliases: &["MORPHEUS_RELAYER_RUN_SNAPSHOT_INTERVAL_MS"],
        default: "60000",
        required: false,
        secret: false,
        description: "Run-snapshot interval (ms, min 0).",
    },
    ConfigSetting {
        key: "runSnapshots.errorBackoffMs",
        aliases: &["MORPHEUS_RELAYER_RUN_SNAPSHOT_ERROR_BACKOFF_MS"],
        default: "300000",
        required: false,
        secret: false,
        description: "Backoff after a failed run-snapshot persist (ms, min 1000).",
    },
    ConfigSetting {
        key: "backpressure.maxFreshEventsPerTick",
        aliases: &["MORPHEUS_RELAYER_MAX_FRESH_EVENTS_PER_TICK"],
        default: "32",
        required: false,
        secret: false,
        description: "Max fresh events admitted per tick (min 1).",
    },
    ConfigSetting {
        key: "backpressure.maxRetryEventsPerTick",
        aliases: &["MORPHEUS_RELAYER_MAX_RETRY_EVENTS_PER_TICK"],
        default: "16",
        required: false,
        secret: false,
        description: "Max retry events admitted per tick (min 1).",
    },
    ConfigSetting {
        key: "backpressure.deferDelayMs",
        aliases: &["MORPHEUS_RELAYER_DEFER_DELAY_MS"],
        default: "5000",
        required: false,
        secret: false,
        description: "Defer delay when backpressure sheds events (ms, min 250).",
    },
    ConfigSetting {
        key: "feedSync.enabled",
        aliases: &["MORPHEUS_FEED_SYNC_ENABLED"],
        default: "true",
        required: false,
        secret: false,
        description: "Price-feed sync loop on/off (any value except \"false\" => on).",
    },
    ConfigSetting {
        key: "feedSync.intervalMs",
        aliases: &["MORPHEUS_FEED_SYNC_INTERVAL_MS"],
        default: "60000",
        required: false,
        secret: false,
        description: "Feed-sync interval (ms, min 1000).",
    },
    ConfigSetting {
        key: "feedSync.timeoutMs",
        aliases: &["MORPHEUS_FEED_SYNC_TIMEOUT_MS"],
        default: "10000",
        required: false,
        secret: false,
        description: "Feed-sync request timeout (ms, clamped 1000..30000).",
    },
    ConfigSetting {
        key: "feedSync.waitForSubmission",
        aliases: &["MORPHEUS_FEED_SYNC_WAIT_FOR_SUBMISSION"],
        default: "false",
        required: false,
        secret: false,
        description: "Wait for on-chain feed submission instead of fast-ack.",
    },
    ConfigSetting {
        key: "feedSync.projectSlug",
        aliases: &["MORPHEUS_FEED_PROJECT_SLUG"],
        default: "morpheus",
        required: false,
        secret: false,
        description: "Feed project slug (only sent when project config lookup is enabled).",
    },
    ConfigSetting {
        key: "feedSync.projectConfigEnabled",
        aliases: &["MORPHEUS_FEED_SYNC_PROJECT_CONFIG_ENABLED"],
        default: "false",
        required: false,
        secret: false,
        description: "Opt-in server-side project-config lookup.",
    },
    ConfigSetting {
        key: "feedSync.provider",
        aliases: &["MORPHEUS_FEED_PROVIDER"],
        default: "(unset)",
        required: false,
        secret: false,
        description: "Single feed provider.",
    },
    ConfigSetting {
        key: "feedSync.providers",
        aliases: &["MORPHEUS_FEED_PROVIDERS"],
        default: "(unset)",
        required: false,
        secret: false,
        description: "Comma list of feed providers.",
    },
    ConfigSetting {
        key: "feedSync.symbols",
        aliases: &["MORPHEUS_FEED_SYMBOLS"],
        default: "(unset)",
        required: false,
        secret: false,
        description: "Comma list of feed symbols to sync.",
    },
    ConfigSetting {
        key: "feedSync.changeThresholdBps",
        aliases: &["MORPHEUS_FEED_CHANGE_THRESHOLD_BPS"],
        default: "10",
        required: false,
        secret: false,
        description: "Min change (bps) before publishing a feed update.",
    },
    ConfigSetting {
        key: "feedSync.minUpdateIntervalMs",
        aliases: &["MORPHEUS_FEED_MIN_UPDATE_INTERVAL_MS"],
        default: "60000",
        required: false,
        secret: false,
        description: "Min interval between feed publications (ms).",
    },
    ConfigSetting {
        key: "feedSync.staleAfterMs",
        aliases: &["MORPHEUS_FEED_STALE_AFTER_MS"],
        default: "300000",
        required: false,
        secret: false,
        description: "Feed staleness threshold (ms).",
    },
    ConfigSetting {
        key: "automation.enabled",
        aliases: &["MORPHEUS_AUTOMATION_ENABLED"],
        default: "true",
        required: false,
        secret: false,
        description: "Automation supervisor on/off (any value except \"false\" => on).",
    },
    ConfigSetting {
        key: "automation.batchSize",
        aliases: &["MORPHEUS_AUTOMATION_BATCH_SIZE"],
        default: "50",
        required: false,
        secret: false,
        description: "Automation job batch size (min 1).",
    },
    ConfigSetting {
        key: "automation.maxQueuedPerTick",
        aliases: &["MORPHEUS_AUTOMATION_MAX_QUEUED_PER_TICK"],
        default: "10",
        required: false,
        secret: false,
        description: "Max automation jobs queued per tick (min 1).",
    },
    ConfigSetting {
        key: "automation.pricePollPairsPerTick",
        aliases: &["MORPHEUS_AUTOMATION_PRICE_PAIRS_PER_TICK"],
        default: "25",
        required: false,
        secret: false,
        description: "Price pairs polled per automation tick (min 1).",
    },
    ConfigSetting {
        key: "automation.defaultPriceCooldownMs",
        aliases: &["MORPHEUS_AUTOMATION_DEFAULT_PRICE_COOLDOWN_MS"],
        default: "60000",
        required: false,
        secret: false,
        description: "Default per-pair price cooldown (ms, min 0).",
    },
    ConfigSetting {
        key: "automation.claimStaleMs",
        aliases: &["MORPHEUS_AUTOMATION_CLAIM_STALE_MS"],
        default: "120000",
        required: false,
        secret: false,
        description: "Automation claim staleness (ms, min 1000).",
    },
    ConfigSetting {
        key: "logFormat",
        aliases: &["MORPHEUS_RELAYER_LOG_FORMAT", "LOG_FORMAT"],
        default: "json",
        required: false,
        secret: false,
        description: "Log output format.",
    },
    ConfigSetting {
        key: "logLevel",
        aliases: &["MORPHEUS_RELAYER_LOG_LEVEL", "LOG_LEVEL"],
        default: "info",
        required: false,
        secret: false,
        description: "Log level.",
    },
    ConfigSetting {
        key: "confirmations.neo_n3",
        aliases: &["MORPHEUS_RELAYER_NEO_N3_CONFIRMATIONS"],
        default: "1",
        required: false,
        secret: false,
        description: "Neo N3 confirmation depth.",
    },
    ConfigSetting {
        key: "confirmations.neox",
        aliases: &["MORPHEUS_RELAYER_NEOX_CONFIRMATIONS"],
        default: "2",
        required: false,
        secret: false,
        description: "Neo X confirmation depth.",
    },
    ConfigSetting {
        key: "startRequestIds.neo_n3",
        aliases: &["MORPHEUS_RELAYER_NEO_N3_START_REQUEST_ID"],
        default: "null (tail)",
        required: false,
        secret: false,
        description: "Neo N3 cold-start request id.",
    },
    ConfigSetting {
        key: "startRequestIds.neox",
        aliases: &["MORPHEUS_RELAYER_NEOX_START_REQUEST_ID"],
        default: "null (tail)",
        required: false,
        secret: false,
        description: "Neo X cold-start request id.",
    },
    ConfigSetting {
        key: "startBlocks.neo_n3",
        aliases: &["MORPHEUS_RELAYER_NEO_N3_START_BLOCK"],
        default: "null",
        required: false,
        secret: false,
        description: "Neo N3 cold-start block.",
    },
    ConfigSetting {
        key: "startBlocks.neox",
        aliases: &["MORPHEUS_RELAYER_NEOX_START_BLOCK"],
        default: "null",
        required: false,
        secret: false,
        description: "Neo X cold-start block.",
    },
    ConfigSetting {
        key: "neo_n3.rpcUrls.mainnet",
        aliases: &["NEO_MAINNET_RPC_URLS", "MAINNET_RPC_URLS", "NEO_RPC_URLS_MAINNET", "NEO_MAINNET_RPC_URL", "MAINNET_RPC_URL", "NEO_RPC_MAINNET"],
        default: "built-in seed list",
        required: false,
        secret: false,
        description: "Neo N3 mainnet RPC URL(s) (used only when network=mainnet).",
    },
    ConfigSetting {
        key: "neo_n3.rpcUrls.testnet",
        aliases: &["NEO_TESTNET_RPC_URLS", "TESTNET_RPC_URLS", "NEO_RPC_URLS_TESTNET", "NEO_TESTNET_RPC_URL", "TESTNET_RPC_URL", "NEO_RPC_TESTNET"],
        default: "built-in seed list",
        required: false,
        secret: false,
        description: "Neo N3 testnet RPC URL(s) (used only when network=testnet).",
    },
    ConfigSetting {
        key: "neo_n3.rpcUrls.generic",
        aliases: &["NEO_RPC_URLS", "NEO_RPC_URL"],
        default: "(unset)",
        required: false,
        secret: false,
        description: "Generic Neo N3 RPC URL(s); only honored when ALLOW_GENERIC_NEO_RPC_URL is true.",
    },
    ConfigSetting {
        key: "neo_n3.allowGenericRpcUrl",
        aliases: &["ALLOW_GENERIC_NEO_RPC_URL"],
        default: "false",
        required: false,
        secret: false,
        description: "Permit the generic (network-unscoped) Neo N3 RPC URL aliases.",
    },
    ConfigSetting {
        key: "neo_n3.networkMagic.mainnet",
        aliases: &["NEO_MAINNET_MAGIC", "MAINNET_NETWORK_MAGIC"],
        default: "860833102",
        required: false,
        secret: false,
        description: "Neo N3 mainnet network magic (used only when network=mainnet).",
    },
    ConfigSetting {
        key: "neo_n3.networkMagic.testnet",
        aliases: &["NEO_TESTNET_MAGIC", "TESTNET_NETWORK_MAGIC"],
        default: "894710606",
        required: false,
        secret: false,
        description: "Neo N3 testnet network magic (used only when network=testnet).",
    },
    ConfigSetting {
        key: "neo_n3.allowGenericNetworkMagic",
        aliases: &["ALLOW_GENERIC_NEO_NETWORK_MAGIC"],
        default: "false",
        required: false,
        secret: false,
        description: "Permit the generic NEO_NETWORK_MAGIC alias.",
    },
    ConfigSetting {
        key: "neo_n3.networkMagic.generic",
        aliases: &["NEO_NETWORK_MAGIC"],
        default: "(unset)",
        required: false,
        secret: false,
        description: "Generic Neo N3 network magic; only honored when ALLOW_GENERIC_NEO_NETWORK_MAGIC is true.",
    },
    ConfigSetting {
        key: "neo_n3.scanMode",
        aliases: &["MORPHEUS_RELAYER_NEO_N3_SCAN_MODE"],
        default: "n3index_notifications (testnet) / block_cursor (mainnet)",
        required: false,
        secret: false,
        description: "Neo N3 discovery scan mode.",
    },
    ConfigSetting {
        key: "neo_n3.fulfillConfirmTimeoutMs",
        aliases: &["MORPHEUS_RELAYER_NEO_N3_FULFILL_CONFIRM_TIMEOUT_MS"],
        default: "null (45s module default)",
        required: false,
        secret: false,
        description: "Neo N3 fulfill application-log confirmation timeout (ms).",
    },
    ConfigSetting {
        key: "neo_n3.fulfillConfirmThrowOnTimeout",
        aliases: &["MORPHEUS_RELAYER_NEO_N3_FULFILL_CONFIRM_THROW_ON_TIMEOUT"],
        default: "true",
        required: false,
        secret: false,
        description: "Re-broadcast (vs silently record) when a Neo N3 fulfill confirmation times out.",
    },
    ConfigSetting {
        key: "neo_n3.indexerUrl",
        aliases: &["MORPHEUS_RELAYER_NEO_N3_INDEXER_URL"],
        default: "https://api.n3index.dev/rest/v1",
        required: false,
        secret: false,
        description: "Neo N3 indexer REST base URL.",
    },
    ConfigSetting {
        key: "neo_n3.oracleContract",
        aliases: &["CONTRACT_MORPHEUS_ORACLE_HASH_MAINNET", "CONTRACT_MORPHEUS_ORACLE_HASH_TESTNET", "CONTRACT_MORPHEUS_ORACLE_HASH"],
        default: "registry neo_n3.contracts.morpheus_oracle",
        required: false,
        secret: false,
        description: "Neo N3 oracle contract hash (network-scoped alias preferred). Required for the Neo N3 request lane.",
    },
    ConfigSetting {
        key: "neo_n3.datafeedContract",
        aliases: &["CONTRACT_MORPHEUS_DATAFEED_HASH_MAINNET", "CONTRACT_MORPHEUS_DATAFEED_HASH_TESTNET", "CONTRACT_MORPHEUS_DATAFEED_HASH"],
        default: "registry neo_n3.contracts.morpheus_datafeed",
        required: false,
        secret: false,
        description: "Neo N3 datafeed contract hash (network-scoped alias preferred).",
    },
    ConfigSetting {
        key: "neo_n3.feeTopUp.enabled",
        aliases: &["MORPHEUS_RELAYER_NEO_N3_AUTO_TOPUP_ENABLED"],
        default: "true",
        required: false,
        secret: false,
        description: "Auto fee top-up of the Neo N3 updater on/off.",
    },
    ConfigSetting {
        key: "neo_n3.feeTopUp.minBalance",
        aliases: &["MORPHEUS_RELAYER_NEO_N3_AUTO_TOPUP_MIN_FIXED8"],
        default: "50000000",
        required: false,
        secret: false,
        description: "GAS balance (fixed8) below which top-up triggers.",
    },
    ConfigSetting {
        key: "neo_n3.feeTopUp.topUpAmount",
        aliases: &["MORPHEUS_RELAYER_NEO_N3_AUTO_TOPUP_AMOUNT_FIXED8"],
        default: "100000000",
        required: false,
        secret: false,
        description: "GAS amount (fixed8) per top-up.",
    },
    ConfigSetting {
        key: "neo_n3.feeTopUp.maxTopUpAmount",
        aliases: &["MORPHEUS_RELAYER_NEO_N3_AUTO_TOPUP_MAX_FIXED8"],
        default: "500000000",
        required: false,
        secret: false,
        description: "Max cumulative top-up amount (fixed8).",
    },
    ConfigSetting {
        key: "neo_n3.custodyKeyIds.fee_funder",
        aliases: &["SIGNER_ROLE_FEE_FUNDER_KEY_ID"],
        default: "(unset)",
        required: false,
        secret: false,
        description: "Custody key id funding updater fee top-ups; required only if auto top-up is enabled and the updater needs funding.",
    },
    ConfigSetting {
        key: "nitro.apiUrl",
        aliases: &["MORPHEUS_MAINNET_RUNTIME_URL", "MORPHEUS_TESTNET_RUNTIME_URL", "MORPHEUS_RUNTIME_URL", "MORPHEUS_MAINNET_NITRO_API_URL", "MORPHEUS_TESTNET_NITRO_API_URL", "NITRO_API_URL"],
        default: "development: public oracle/edge fallbacks; production: unset",
        required: false,
        secret: false,
        description: "Nitro worker API URL(s); production confidential calls require an explicit URL and use only the first endpoint.",
    },
    ConfigSetting {
        key: "nitro.allowFallback",
        aliases: &["MORPHEUS_RELAYER_ALLOW_RUNTIME_FALLBACKS"],
        default: "true outside production; false in production",
        required: false,
        secret: false,
        description: "Development migration switch for Nitro endpoint failover; production ignores it and fails closed on the primary endpoint.",
    },
    ConfigSetting {
        key: "nitro.signerUrl",
        aliases: &["NITRO_SIGNER_URL", "MORPHEUS_SIGNER_URL"],
        default: "falls back to nitro.apiUrl",
        required: false,
        secret: false,
        description: "Frontier/legacy signer URL. Neo N3 private keys live in the separate custody service, not this relayer-facing configuration.",
    },
    ConfigSetting {
        key: "nitro.custodyUrl",
        aliases: &["SIGNER_SERVICE_URL"],
        default: "(unset)",
        required: false,
        secret: false,
        description: "Custody signer service base URL; every enabled Neo N3/NeoX request or feed submission signs through it.",
    },
    ConfigSetting {
        key: "nitro.custodyToken",
        aliases: &["SIGNER_SERVICE_TOKEN"],
        default: "(unset)",
        required: false,
        secret: true,
        description: "Bearer token for the custody signer service API.",
    },
    ConfigSetting {
        key: "nitro.enclaveFulfill",
        aliases: &["MORPHEUS_RELAYER_ENCLAVE_FULFILL"],
        default: "false",
        required: false,
        secret: false,
        description: "Compute-in-enclave cutover flag (atomic POST /oracle/fulfill).",
    },
    ConfigSetting {
        key: "nitro.expectedPcr0",
        aliases: &["MORPHEUS_EXPECTED_PCR0"],
        default: "(unset, no PCR0 pinning)",
        required: false,
        secret: false,
        description: "Expected enclave PCR0 (hex) for attestation binding.",
    },
    ConfigSetting {
        key: "nitro.verifyEnclaveSignature",
        aliases: &["MORPHEUS_RELAYER_VERIFY_ENCLAVE_SIGNATURE"],
        default: "false",
        required: false,
        secret: false,
        description: "Verify enclave signature against the on-chain oracle_verifier key before submit.",
    },
    ConfigSetting {
        key: "nitro.enclaveFulfillUrl",
        aliases: &["MORPHEUS_RELAYER_ENCLAVE_FULFILL_URL"],
        default: "falls back to signer URL / apiUrl",
        required: false,
        secret: false,
        description: "Enclave /oracle/fulfill base URL.",
    },
    ConfigSetting {
        key: "nitro.decryptUrl",
        aliases: &["MORPHEUS_RELAYER_ENCLAVE_DECRYPT_URL", "MORPHEUS_DECRYPT_URL"],
        default: "falls back to enclave-fulfill / signer / apiUrl",
        required: false,
        secret: false,
        description: "Enclave-only confidential /oracle/decrypt URL (never fails over).",
    },
    ConfigSetting {
        key: "nitro.nitroRootCertPem",
        aliases: &["MORPHEUS_NITRO_ROOT_CERT_PEM"],
        default: "falls back to file at MORPHEUS_NITRO_ROOT_CERT_PATH",
        required: false,
        secret: true,
        description: "PEM of the pinned AWS Nitro attestation root cert (inline).",
    },
    ConfigSetting {
        key: "nitro.nitroRootCertPath",
        aliases: &["MORPHEUS_NITRO_ROOT_CERT_PATH"],
        default: "(unset)",
        required: false,
        secret: false,
        description: "Path to the pinned AWS Nitro attestation root cert PEM file.",
    },
    ConfigSetting {
        key: "nitro.attestationMaxAgeMs",
        aliases: &["MORPHEUS_ATTESTATION_MAX_AGE_MS"],
        default: "0 (timestamp-age gate disabled)",
        required: false,
        secret: false,
        description: "Max age of an attestation document timestamp before stale (ms).",
    },
    ConfigSetting {
        key: "nitro.token",
        aliases: &["MORPHEUS_RUNTIME_TOKEN", "NITRO_API_TOKEN", "NITRO_SHARED_SECRET"],
        default: "(unset)",
        required: false,
        secret: true,
        description: "Shared secret / bearer token for the Nitro worker + enclave.",
    },
    ConfigSetting {
        key: "nitro.timeoutMs",
        aliases: &["MORPHEUS_NITRO_TIMEOUT_MS"],
        default: "10000",
        required: false,
        secret: false,
        description: "Nitro request timeout (ms, clamped 1000..10000).",
    },
    ConfigSetting {
        key: "neox.scanMode",
        aliases: &["MORPHEUS_RELAYER_NEOX_SCAN_MODE"],
        default: "request_cursor",
        required: false,
        secret: false,
        description: "Neo X discovery scan mode.",
    },
    ConfigSetting {
        key: "neox.rpcUrl",
        aliases: &["MORPHEUS_RELAYER_NEOX_RPC_URL", "NEOX_RPC"],
        default: "registry neox.rpc_url or per-net public default",
        required: false,
        secret: false,
        description: "Neo X primary RPC URL (signer/submit path stays pinned here). Required for the Neo X lane.",
    },
    ConfigSetting {
        key: "neox.rpcUrls",
        aliases: &["MORPHEUS_RELAYER_NEOX_RPC_URLS", "NEOX_RPC_URLS"],
        default: "per-net public defaults appended after primary",
        required: false,
        secret: false,
        description: "Neo X read-failover RPC list.",
    },
    ConfigSetting {
        key: "neox.chainId",
        aliases: &["MORPHEUS_RELAYER_NEOX_CHAIN_ID", "NEOX_CHAIN_ID"],
        default: "47763 (mainnet) / 12227332 (testnet)",
        required: false,
        secret: false,
        description: "Neo X chain id (bound into the fulfillment digest).",
    },
    ConfigSetting {
        key: "neox.oracleContract",
        aliases: &["MORPHEUS_RELAYER_NEOX_ORACLE", "NEOX_ORACLE"],
        default: "registry neox.contracts.morpheus_oracle",
        required: false,
        secret: false,
        description: "Neo X oracle contract address. Required for the Neo X lane.",
    },
    ConfigSetting {
        key: "neox.datafeedContract",
        aliases: &["MORPHEUS_RELAYER_NEOX_DATAFEED", "NEOX_DATAFEED"],
        default: "registry neox.contracts.morpheus_datafeed",
        required: false,
        secret: false,
        description: "Neo X datafeed contract address. Required when Neo X feed sync is enabled.",
    },
    ConfigSetting {
        key: "neox.feedGasLimit",
        aliases: &["MORPHEUS_RELAYER_NEOX_FEED_GAS_LIMIT"],
        default: "2000000",
        required: false,
        secret: false,
        description: "Neo X feed update gas ceiling; eth_estimateGas must fit below it.",
    },
    ConfigSetting {
        key: "neox.updaterPrivateKey",
        aliases: &["MORPHEUS_RELAYER_NEOX_UPDATER_PK", "NEOX_UPDATER_PK", "NEOX_FEED_PK"],
        default: "(unset)",
        required: false,
        secret: true,
        description: "Legacy test-only Neo X updater private key. The Rust relayer never requires or consumes it.",
    },
    ConfigSetting {
        key: "neox.custodyKeyIds.updater",
        aliases: &["SIGNER_ROLE_NEOX_UPDATER_KEY_ID"],
        default: "(unset)",
        required: false,
        secret: false,
        description: "Neo X custody key id signing fulfillment and feed transactions. Required whenever an enabled Neo X lane can submit.",
    },
    ConfigSetting {
        key: "neox.custodyKeyIds.verifier",
        aliases: &["SIGNER_ROLE_NEOX_VERIFIER_KEY_ID"],
        default: "(unset)",
        required: false,
        secret: false,
        description: "Neo X custody key id signing chain-bound EIP-191 fulfillment digests. Must differ from the updater key.",
    },
    ConfigSetting {
        key: "neox.verifierPrivateKey",
        aliases: &["MORPHEUS_RELAYER_NEOX_VERIFIER_PK", "NEOX_VERIFIER_PK"],
        default: "(unset)",
        required: false,
        secret: true,
        description: "Forbidden legacy Neo X verifier private key; the Rust relayer accepts only a custody verifier key id.",
    },
    ConfigSetting {
        key: "neox.confirmTimeoutMs",
        aliases: &["MORPHEUS_RELAYER_NEOX_CONFIRM_TIMEOUT_MS"],
        default: "45000",
        required: false,
        secret: false,
        description: "Neo X fulfillRequest receipt-wait deadline (ms, min 1000).",
    },
    ConfigSetting {
        key: "neox.workerUrl",
        aliases: &["MORPHEUS_RELAYER_NEOX_WORKER_URL", "NEOX_WORKER_URL"],
        default: "(unset)",
        required: false,
        secret: false,
        description: "Neo X worker URL.",
    },
    ConfigSetting {
        key: "metricsServer.host",
        aliases: &["MORPHEUS_RELAYER_METRICS_HOST"],
        default: "127.0.0.1",
        required: false,
        secret: false,
        description: "Metrics server bind host.",
    },
    ConfigSetting {
        key: "metricsServer.port",
        aliases: &["MORPHEUS_RELAYER_METRICS_PORT"],
        default: "9464",
        required: false,
        secret: false,
        description: "Metrics server port (min 1).",
    },
    ConfigSetting {
        key: "metricsServer.path",
        aliases: &["MORPHEUS_RELAYER_METRICS_PATH"],
        default: "/metrics",
        required: false,
        secret: false,
        description: "Metrics server scrape path.",
    },
    ConfigSetting {
        key: "heartbeats.relayer",
        aliases: &["MORPHEUS_BETTERSTACK_RELAYER_HEARTBEAT_URL"],
        default: "(unset)",
        required: false,
        secret: false,
        description: "BetterStack heartbeat URL for the request relayer.",
    },
    ConfigSetting {
        key: "heartbeats.feedRelayer",
        aliases: &["MORPHEUS_BETTERSTACK_RELAYER_FEED_HEARTBEAT_URL"],
        default: "(unset)",
        required: false,
        secret: false,
        description: "BetterStack heartbeat URL for the feed relayer.",
    },
    ConfigSetting {
        key: "heartbeats.failure",
        aliases: &["MORPHEUS_BETTERSTACK_RELAYER_FAILURE_URL"],
        default: "(unset)",
        required: false,
        secret: false,
        description: "BetterStack failure push-alert URL.",
    },
    ConfigSetting {
        key: "heartbeats.deadLetter",
        aliases: &["MORPHEUS_BETTERSTACK_RELAYER_DEADLETTER_URL"],
        default: "falls back to heartbeats.failure",
        required: false,
        secret: false,
        description: "BetterStack dead-letter push-alert URL.",
    },
    ConfigSetting {
        key: "neo_n3.custodyKeyIds.updater",
        aliases: &["SIGNER_ROLE_UPDATER_KEY_ID"],
        default: "(unset)",
        required: false,
        secret: false,
        description: "Custody key id signing Neo N3 fulfillment and feed transactions. Required whenever an enabled Neo N3 lane can submit.",
    },
    ConfigSetting {
        key: "neo_n3.custodyKeyIds.oracle_verifier",
        aliases: &["SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID"],
        default: "(unset)",
        required: false,
        secret: false,
        description: "Custody key id signing fulfillment result payloads; its public key must match the on-chain-pinned oracle_verifier.",
    },
    ConfigSetting {
        key: "runtimeConfigJson",
        aliases: &["MORPHEUS_RUNTIME_CONFIG_JSON"],
        default: "(unset)",
        required: false,
        secret: true,
        description: "JSON object of packed env values; consulted by env() as a fallback after process.env. Treated as secret (may contain keys/tokens).",
    },
];
/// Every env alias the schema knows about (deduped, first-occurrence order —
/// JS `Set` iteration order), used by the typo-detector to decide whether a
/// MORPHEUS_*/NITRO_* var is unknown (port of `knownEnvAliases`).
pub fn known_env_aliases() -> Vec<&'static str> {
    let mut known: Vec<&'static str> = Vec::new();
    let mut push = |name: &'static str| {
        if !known.contains(&name) {
            known.push(name);
        }
    };
    for key in DIRECT_CONTROL_ENV_KEYS {
        push(key);
    }
    for setting in CONFIG_SCHEMA {
        for alias in setting.aliases {
            push(alias);
        }
    }
    known
}

/// Secret env-var-name detection, single-sourced in `secret_redaction` (the
/// union of the dump's fragments and the structured logger's, so neither sink
/// can lose coverage). Port of config-schema.js `isSecretEnvName`.
pub fn is_secret_env_name(name: &str) -> bool {
    secret_redaction::is_secret_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// Pinned against the JS oracle (node -e over config-schema.js): 113
    /// logical keys, 157 alias references with zero duplicates, 7 secret
    /// entries, 0 required. A drift here means the JS manifest changed and
    /// this table must be regenerated.
    #[test]
    fn manifest_shape_matches_js_oracle() {
        assert_eq!(CONFIG_SCHEMA.len(), 113, "logical key count");
        let alias_refs: Vec<&str> = CONFIG_SCHEMA
            .iter()
            .flat_map(|s| s.aliases.iter().copied())
            .collect();
        assert_eq!(alias_refs.len(), 157, "alias reference count");
        let unique: HashSet<&str> = alias_refs.iter().copied().collect();
        assert_eq!(unique.len(), 157, "aliases must be globally unique");
        assert_eq!(
            CONFIG_SCHEMA.iter().filter(|s| s.secret).count(),
            7,
            "secret-marked entries"
        );
        assert_eq!(
            CONFIG_SCHEMA.iter().filter(|s| s.required).count(),
            0,
            "required entries"
        );
    }

    #[test]
    fn keys_are_unique() {
        let mut seen = HashSet::new();
        for setting in CONFIG_SCHEMA {
            assert!(seen.insert(setting.key), "duplicate key {}", setting.key);
        }
    }

    #[test]
    fn known_env_aliases_covers_all_schema_entries() {
        let known = known_env_aliases();
        let unique: HashSet<_> = known.iter().copied().collect();
        assert_eq!(known.len(), unique.len(), "known aliases must be unique");
        let expected: HashSet<_> = DIRECT_CONTROL_ENV_KEYS
            .iter()
            .copied()
            .chain(
                CONFIG_SCHEMA
                    .iter()
                    .flat_map(|setting| setting.aliases.iter().copied()),
            )
            .collect();
        assert_eq!(
            unique, expected,
            "known aliases must contain exactly the schema and direct-control union"
        );
        let direct: HashSet<_> = DIRECT_CONTROL_ENV_KEYS.iter().copied().collect();
        assert_eq!(
            direct.len(),
            DIRECT_CONTROL_ENV_KEYS.len(),
            "direct-control aliases must not repeat"
        );
        for setting in CONFIG_SCHEMA {
            for alias in setting.aliases {
                assert!(known.contains(alias), "missing alias {alias}");
            }
        }
        // Direct controls may overlap schema aliases, but may not disappear
        // from typo detection as new runtime configuration is introduced.
        for key in DIRECT_CONTROL_ENV_KEYS {
            assert!(known.contains(key), "missing direct key {key}");
        }
        for key in [
            "MORPHEUS_ALLOW_UNAVAILABLE_AUTOMATION",
            "MORPHEUS_DELIVERY_PROTOCOL",
            "MORPHEUS_N3_RECONCILIATION_ARCHIVE_RPC_URLS",
            "MORPHEUS_ALLOW_LEGACY_LOCAL",
        ] {
            assert!(
                direct.contains(key),
                "runtime control missing from authority: {key}"
            );
        }
    }

    #[test]
    fn secret_detection_is_the_single_sourced_predicate() {
        assert!(is_secret_env_name("SIGNER_SERVICE_TOKEN"));
        assert!(!is_secret_env_name("MORPHEUS_RELAYER_METRICS_PORT"));
    }
}
