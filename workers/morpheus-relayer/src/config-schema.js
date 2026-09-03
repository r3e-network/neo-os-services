import { isSecretName } from './lib/secret-redaction.js';

// Declarative manifest of every environment variable createRelayerConfig() reads.
//
// WHY: config.js resolves ~146 env vars through deep `env(alias1, alias2, ...)`
// alias chains with no schema, so an operator has no way to (a) see the RESOLVED
// configuration, (b) learn which alias actually won, or (c) catch a typo'd
// variable (a misspelled MORPHEUS_*/NITRO_* var is silently ignored and
// the default is used). This manifest is the single declarative source the
// `config:validate` / `config:dump` operator commands introspect. It does NOT
// participate in runtime resolution — createRelayerConfig() is unchanged — it is
// an additive, read-only description of that resolution.
//
// TRUTHFULNESS: each entry's `aliases` list is the SAME ordered alias list passed
// to the corresponding `env(...)` call in config.js. The ordering matters: env()
// returns the first alias that has a non-empty value (process.env first across
// ALL aliases, then the packed MORPHEUS_RUNTIME_CONFIG_JSON object), so the alias
// order here is the precedence order. config-schema.test.mjs asserts that every
// alias named in this manifest is also referenced by config.js (and flags drift)
// so the manifest cannot quietly rot away from the resolver it documents.

// Known non-secret control variables that are consumed directly via process.env
// (not through the env() alias helper) or otherwise steer resolution. Listed so
// the typo-detector does not flag them as unknown.
export const DIRECT_CONTROL_ENV_KEYS = [
  'MORPHEUS_RUNTIME_CONFIG_JSON',
  'MORPHEUS_NETWORK',
  'NEXT_PUBLIC_MORPHEUS_NETWORK',
];

// Secret env-var-name detection is single-sourced in lib/secret-redaction.js (the
// union of this dump's fragments and the structured-logger's, so neither sink can
// lose coverage). Re-exported here under the name config-introspect.js imports.
export function isSecretEnvName(name) {
  return isSecretName(name);
}

// Each setting:
//   key        stable logical name (dot-path mirrors the config object shape)
//   aliases    ordered env var names, exactly as passed to env(...) in config.js
//   default    human description of the fallback when no alias is set
//   required   true => validate fails if no alias resolves to a value
//   secret     true => value is redacted in dump (overrides name-based detection)
//   description one-liner
//
// `required` here means "the relayer cannot function without it in a typical
// deployment". Several settings are conditionally required (e.g. the Neo N3
// custody updater key id is only needed when neo_n3 is active / not feed-only);
// those are marked required:false with the condition in the description, and
// the dynamic validator (validateRelayerConfig) layers the conditional checks
// on top using the built config object.
export const CONFIG_SCHEMA = [
  {
    key: 'network',
    aliases: ['MORPHEUS_NETWORK', 'NEXT_PUBLIC_MORPHEUS_NETWORK'],
    default: 'testnet',
    required: false,
    description: 'Target network (mainnet|testnet); selects registry + RPC defaults.',
  },
  {
    key: 'mode',
    aliases: ['MORPHEUS_RELAYER_MODE'],
    default: 'combined',
    required: false,
    description: 'Relayer mode: combined | feed_only | requests_only.',
  },
  {
    key: 'useDerivedKeys',
    aliases: ['NITRO_USE_DERIVED_KEYS'],
    default: 'false',
    required: false,
    description:
      'Relayed to runtime API calls (useDerivedKeys payload flag) for in-enclave derived-key lanes. Relayer Neo N3 signing no longer uses derived keys — it always goes through the custody signer service.',
  },
  {
    key: 'instanceId',
    aliases: ['MORPHEUS_RELAYER_INSTANCE_ID'],
    default: 'derived: <mode>:<network>:<hostname>:<pid>',
    required: false,
    description: 'Stable instance identifier for cross-instance durable-queue claims.',
  },
  {
    key: 'activeChains',
    aliases: ['MORPHEUS_ACTIVE_CHAINS'],
    default: 'neo_n3',
    required: false,
    description: 'Comma list of active chains (subset of neo_n3,neox).',
  },
  {
    key: 'pollIntervalMs',
    aliases: ['MORPHEUS_RELAYER_POLL_INTERVAL_MS'],
    default: '5000',
    required: false,
    description: 'Main loop poll interval (ms).',
  },
  {
    key: 'concurrency',
    aliases: ['MORPHEUS_RELAYER_CONCURRENCY'],
    default: '4',
    required: false,
    description: 'Max concurrent request processors (min 1).',
  },
  {
    key: 'maxBlocksPerTick',
    aliases: ['MORPHEUS_RELAYER_MAX_BLOCKS_PER_TICK'],
    default: '250',
    required: false,
    description: 'Max blocks scanned per tick (min 1).',
  },
  {
    key: 'maxRetries',
    aliases: ['MORPHEUS_RELAYER_MAX_RETRIES'],
    default: '5',
    required: false,
    description: 'Max processing retries before dead-letter (min 0).',
  },
  {
    key: 'maxCallbackRetries',
    aliases: ['MORPHEUS_RELAYER_MAX_CALLBACK_RETRIES'],
    default: 'maxRetries * 2',
    required: false,
    description: 'Max callback-delivery / failure-finalize redelivery attempts (min 1).',
  },
  {
    key: 'retryBaseDelayMs',
    aliases: ['MORPHEUS_RELAYER_RETRY_BASE_DELAY_MS'],
    default: '5000',
    required: false,
    description: 'Base retry backoff delay (ms, min 250).',
  },
  {
    key: 'retryMaxDelayMs',
    aliases: ['MORPHEUS_RELAYER_RETRY_MAX_DELAY_MS'],
    default: '10000',
    required: false,
    description: 'Retry backoff cap (ms, clamped 1000..600000).',
  },
  {
    key: 'statePersistMinIntervalMs',
    aliases: ['MORPHEUS_RELAYER_STATE_PERSIST_MIN_INTERVAL_MS'],
    default: '250',
    required: false,
    description: 'Min interval between local state-file writes (ms; 0 = write on every call).',
  },
  {
    key: 'processedCacheSize',
    aliases: ['MORPHEUS_RELAYER_PROCESSED_CACHE_SIZE'],
    default: '5000',
    required: false,
    description: 'Processed-request de-dup cache size (min 100).',
  },
  {
    key: 'deadLetterLimit',
    aliases: ['MORPHEUS_RELAYER_DEAD_LETTER_LIMIT'],
    default: '500',
    required: false,
    description: 'Max retained dead-letter entries (min 10).',
  },
  {
    key: 'retryQueueLimit',
    aliases: ['MORPHEUS_RELAYER_RETRY_QUEUE_LIMIT'],
    default: '0',
    required: false,
    description: 'In-memory retry-queue ceiling per chain (0 = unbounded).',
  },
  {
    key: 'stateFile',
    aliases: ['MORPHEUS_RELAYER_STATE_FILE'],
    default: 'derived: .morpheus-relayer-state[.<mode>].json',
    required: false,
    description: 'Local state-file path (relative to repo root unless absolute).',
  },

  // --- Durable queue (Supabase) ---
  {
    key: 'supabaseUrl',
    aliases: ['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'morpheus_SUPABASE_URL'],
    default: '(unset)',
    required: false,
    description: 'Supabase URL; presence enables the durable queue by default.',
  },
  {
    key: 'supabaseKey',
    aliases: [
      'SUPABASE_SECRET_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'morpheus_SUPABASE_SECRET_KEY',
      'morpheus_SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_SERVICE_KEY',
    ],
    default: '(unset)',
    required: false,
    secret: true,
    description: 'Supabase service key; presence enables the durable queue by default.',
  },
  {
    key: 'durableQueue.enabled',
    aliases: ['MORPHEUS_DURABLE_QUEUE_ENABLED'],
    default: 'true when both Supabase URL + key are set',
    required: false,
    description: 'Force durable cross-instance queue on/off.',
  },
  {
    key: 'durableQueue.failClosed',
    aliases: ['MORPHEUS_DURABLE_QUEUE_FAIL_CLOSED'],
    default: 'mirrors durableQueue.enabled',
    required: false,
    description: 'Fail closed (skip processing) when the durable queue is unreachable.',
  },
  {
    key: 'durableQueue.allowLocalClaimDuringBackoff',
    aliases: ['MORPHEUS_DURABLE_QUEUE_ALLOW_LOCAL_CLAIM_DURING_BACKOFF'],
    default: 'false',
    required: false,
    description:
      'Allow local claim while the shared idempotency store is in backoff (single-instance only; ignored in production).',
  },
  {
    key: 'durableQueue.syncLimit',
    aliases: ['MORPHEUS_DURABLE_QUEUE_SYNC_LIMIT'],
    default: '200',
    required: false,
    description: 'Durable-queue sync batch size (min 1).',
  },
  {
    key: 'durableQueue.staleProcessingMs',
    aliases: ['MORPHEUS_DURABLE_QUEUE_STALE_PROCESSING_MS'],
    default: '45000',
    required: false,
    description: 'Age after which an in-progress durable claim is considered stale (ms, min 1000).',
  },

  // --- Run snapshots ---
  {
    key: 'runSnapshots.enabled',
    aliases: ['MORPHEUS_RELAYER_RUN_SNAPSHOTS_ENABLED'],
    default: 'true',
    required: false,
    description: 'Periodic run-snapshot persistence on/off.',
  },
  {
    key: 'runSnapshots.intervalMs',
    aliases: ['MORPHEUS_RELAYER_RUN_SNAPSHOT_INTERVAL_MS'],
    default: '60000',
    required: false,
    description: 'Run-snapshot interval (ms, min 0).',
  },
  {
    key: 'runSnapshots.errorBackoffMs',
    aliases: ['MORPHEUS_RELAYER_RUN_SNAPSHOT_ERROR_BACKOFF_MS'],
    default: '300000',
    required: false,
    description: 'Backoff after a failed run-snapshot persist (ms, min 1000).',
  },

  // --- Backpressure ---
  {
    key: 'backpressure.maxFreshEventsPerTick',
    aliases: ['MORPHEUS_RELAYER_MAX_FRESH_EVENTS_PER_TICK'],
    default: '32',
    required: false,
    description: 'Max fresh events admitted per tick (min 1).',
  },
  {
    key: 'backpressure.maxRetryEventsPerTick',
    aliases: ['MORPHEUS_RELAYER_MAX_RETRY_EVENTS_PER_TICK'],
    default: '16',
    required: false,
    description: 'Max retry events admitted per tick (min 1).',
  },
  {
    key: 'backpressure.deferDelayMs',
    aliases: ['MORPHEUS_RELAYER_DEFER_DELAY_MS'],
    default: '5000',
    required: false,
    description: 'Defer delay when backpressure sheds events (ms, min 250).',
  },

  // --- Feed sync ---
  {
    key: 'feedSync.enabled',
    aliases: ['MORPHEUS_FEED_SYNC_ENABLED'],
    default: 'true',
    required: false,
    description: 'Price-feed sync loop on/off (any value except "false" => on).',
  },
  {
    key: 'feedSync.intervalMs',
    aliases: ['MORPHEUS_FEED_SYNC_INTERVAL_MS'],
    default: '60000',
    required: false,
    description: 'Feed-sync interval (ms, min 1000).',
  },
  {
    key: 'feedSync.timeoutMs',
    aliases: ['MORPHEUS_FEED_SYNC_TIMEOUT_MS'],
    default: '10000',
    required: false,
    description: 'Feed-sync request timeout (ms, clamped 1000..30000).',
  },
  {
    key: 'feedSync.waitForSubmission',
    aliases: ['MORPHEUS_FEED_SYNC_WAIT_FOR_SUBMISSION'],
    default: 'false',
    required: false,
    description: 'Wait for on-chain feed submission instead of fast-ack.',
  },
  {
    key: 'feedSync.projectSlug',
    aliases: ['MORPHEUS_FEED_PROJECT_SLUG'],
    default: 'morpheus',
    required: false,
    description: 'Feed project slug (only sent when project config lookup is enabled).',
  },
  {
    key: 'feedSync.projectConfigEnabled',
    aliases: ['MORPHEUS_FEED_SYNC_PROJECT_CONFIG_ENABLED'],
    default: 'false',
    required: false,
    description: 'Opt-in server-side project-config lookup.',
  },
  {
    key: 'feedSync.provider',
    aliases: ['MORPHEUS_FEED_PROVIDER'],
    default: '(unset)',
    required: false,
    description: 'Single feed provider.',
  },
  {
    key: 'feedSync.providers',
    aliases: ['MORPHEUS_FEED_PROVIDERS'],
    default: '(unset)',
    required: false,
    description: 'Comma list of feed providers.',
  },
  {
    key: 'feedSync.symbols',
    aliases: ['MORPHEUS_FEED_SYMBOLS'],
    default: '(unset)',
    required: false,
    description: 'Comma list of feed symbols to sync.',
  },
  {
    key: 'feedSync.changeThresholdBps',
    aliases: ['MORPHEUS_FEED_CHANGE_THRESHOLD_BPS'],
    default: '10',
    required: false,
    description: 'Min change (bps) before publishing a feed update.',
  },
  {
    key: 'feedSync.minUpdateIntervalMs',
    aliases: ['MORPHEUS_FEED_MIN_UPDATE_INTERVAL_MS'],
    default: '60000',
    required: false,
    description: 'Min interval between feed publications (ms).',
  },
  {
    key: 'feedSync.staleAfterMs',
    aliases: ['MORPHEUS_FEED_STALE_AFTER_MS'],
    default: '300000',
    required: false,
    description: 'Feed staleness threshold (ms).',
  },

  // --- Automation ---
  {
    key: 'automation.enabled',
    aliases: ['MORPHEUS_AUTOMATION_ENABLED'],
    default: 'true',
    required: false,
    description: 'Automation supervisor on/off (any value except "false" => on).',
  },
  {
    key: 'automation.batchSize',
    aliases: ['MORPHEUS_AUTOMATION_BATCH_SIZE'],
    default: '50',
    required: false,
    description: 'Automation job batch size (min 1).',
  },
  {
    key: 'automation.maxQueuedPerTick',
    aliases: ['MORPHEUS_AUTOMATION_MAX_QUEUED_PER_TICK'],
    default: '10',
    required: false,
    description: 'Max automation jobs queued per tick (min 1).',
  },
  {
    key: 'automation.pricePollPairsPerTick',
    aliases: ['MORPHEUS_AUTOMATION_PRICE_PAIRS_PER_TICK'],
    default: '25',
    required: false,
    description: 'Price pairs polled per automation tick (min 1).',
  },
  {
    key: 'automation.defaultPriceCooldownMs',
    aliases: ['MORPHEUS_AUTOMATION_DEFAULT_PRICE_COOLDOWN_MS'],
    default: '60000',
    required: false,
    description: 'Default per-pair price cooldown (ms, min 0).',
  },
  {
    key: 'automation.claimStaleMs',
    aliases: ['MORPHEUS_AUTOMATION_CLAIM_STALE_MS'],
    default: '120000',
    required: false,
    description: 'Automation claim staleness (ms, min 1000).',
  },

  // --- Logging ---
  {
    key: 'logFormat',
    aliases: ['MORPHEUS_RELAYER_LOG_FORMAT', 'LOG_FORMAT'],
    default: 'json',
    required: false,
    description: 'Log output format.',
  },
  {
    key: 'logLevel',
    aliases: ['MORPHEUS_RELAYER_LOG_LEVEL', 'LOG_LEVEL'],
    default: 'info',
    required: false,
    description: 'Log level.',
  },

  // --- Confirmations / cursors ---
  {
    key: 'confirmations.neo_n3',
    aliases: ['MORPHEUS_RELAYER_NEO_N3_CONFIRMATIONS'],
    default: '1',
    required: false,
    description: 'Neo N3 confirmation depth.',
  },
  {
    key: 'confirmations.neox',
    aliases: ['MORPHEUS_RELAYER_NEOX_CONFIRMATIONS'],
    default: '2',
    required: false,
    description: 'Neo X confirmation depth.',
  },
  {
    key: 'startRequestIds.neo_n3',
    aliases: ['MORPHEUS_RELAYER_NEO_N3_START_REQUEST_ID'],
    default: 'null (tail)',
    required: false,
    description: 'Neo N3 cold-start request id.',
  },
  {
    key: 'startRequestIds.neox',
    aliases: ['MORPHEUS_RELAYER_NEOX_START_REQUEST_ID'],
    default: 'null (tail)',
    required: false,
    description: 'Neo X cold-start request id.',
  },
  {
    key: 'startBlocks.neo_n3',
    aliases: ['MORPHEUS_RELAYER_NEO_N3_START_BLOCK'],
    default: 'null',
    required: false,
    description: 'Neo N3 cold-start block.',
  },
  {
    key: 'startBlocks.neox',
    aliases: ['MORPHEUS_RELAYER_NEOX_START_BLOCK'],
    default: 'null',
    required: false,
    description: 'Neo X cold-start block.',
  },

  // --- Neo N3 RPC / network magic ---
  {
    key: 'neo_n3.rpcUrls.mainnet',
    aliases: [
      'NEO_MAINNET_RPC_URLS',
      'MAINNET_RPC_URLS',
      'NEO_RPC_URLS_MAINNET',
      'NEO_MAINNET_RPC_URL',
      'MAINNET_RPC_URL',
      'NEO_RPC_MAINNET',
    ],
    default: 'built-in seed list',
    required: false,
    description: 'Neo N3 mainnet RPC URL(s) (used only when network=mainnet).',
  },
  {
    key: 'neo_n3.rpcUrls.testnet',
    aliases: [
      'NEO_TESTNET_RPC_URLS',
      'TESTNET_RPC_URLS',
      'NEO_RPC_URLS_TESTNET',
      'NEO_TESTNET_RPC_URL',
      'TESTNET_RPC_URL',
      'NEO_RPC_TESTNET',
    ],
    default: 'built-in seed list',
    required: false,
    description: 'Neo N3 testnet RPC URL(s) (used only when network=testnet).',
  },
  {
    key: 'neo_n3.rpcUrls.generic',
    aliases: ['NEO_RPC_URLS', 'NEO_RPC_URL'],
    default: '(unset)',
    required: false,
    description: 'Generic Neo N3 RPC URL(s); only honored when ALLOW_GENERIC_NEO_RPC_URL is true.',
  },
  {
    key: 'neo_n3.allowGenericRpcUrl',
    aliases: ['ALLOW_GENERIC_NEO_RPC_URL'],
    default: 'false',
    required: false,
    description: 'Permit the generic (network-unscoped) Neo N3 RPC URL aliases.',
  },
  {
    key: 'neo_n3.networkMagic.mainnet',
    aliases: ['NEO_MAINNET_MAGIC', 'MAINNET_NETWORK_MAGIC'],
    default: '860833102',
    required: false,
    description: 'Neo N3 mainnet network magic (used only when network=mainnet).',
  },
  {
    key: 'neo_n3.networkMagic.testnet',
    aliases: ['NEO_TESTNET_MAGIC', 'TESTNET_NETWORK_MAGIC'],
    default: '894710606',
    required: false,
    description: 'Neo N3 testnet network magic (used only when network=testnet).',
  },
  {
    key: 'neo_n3.allowGenericNetworkMagic',
    aliases: ['ALLOW_GENERIC_NEO_NETWORK_MAGIC'],
    default: 'false',
    required: false,
    description: 'Permit the generic NEO_NETWORK_MAGIC alias.',
  },
  {
    key: 'neo_n3.networkMagic.generic',
    aliases: ['NEO_NETWORK_MAGIC'],
    default: '(unset)',
    required: false,
    description:
      'Generic Neo N3 network magic; only honored when ALLOW_GENERIC_NEO_NETWORK_MAGIC is true.',
  },

  // --- Neo N3 scan / indexer / contracts ---
  {
    key: 'neo_n3.scanMode',
    aliases: ['MORPHEUS_RELAYER_NEO_N3_SCAN_MODE'],
    default: 'n3index_notifications (testnet) / block_cursor (mainnet)',
    required: false,
    description: 'Neo N3 discovery scan mode.',
  },
  {
    key: 'neo_n3.fulfillConfirmTimeoutMs',
    aliases: ['MORPHEUS_RELAYER_NEO_N3_FULFILL_CONFIRM_TIMEOUT_MS'],
    default: 'null (45s module default)',
    required: false,
    description: 'Neo N3 fulfill application-log confirmation timeout (ms).',
  },
  {
    key: 'neo_n3.fulfillConfirmThrowOnTimeout',
    aliases: ['MORPHEUS_RELAYER_NEO_N3_FULFILL_CONFIRM_THROW_ON_TIMEOUT'],
    default: 'true',
    required: false,
    description: 'Re-broadcast (vs silently record) when a Neo N3 fulfill confirmation times out.',
  },
  {
    key: 'neo_n3.indexerUrl',
    aliases: ['MORPHEUS_RELAYER_NEO_N3_INDEXER_URL'],
    default: 'https://api.n3index.dev/rest/v1',
    required: false,
    description: 'Neo N3 indexer REST base URL.',
  },
  {
    key: 'neo_n3.oracleContract',
    aliases: [
      'CONTRACT_MORPHEUS_ORACLE_HASH_MAINNET',
      'CONTRACT_MORPHEUS_ORACLE_HASH_TESTNET',
      'CONTRACT_MORPHEUS_ORACLE_HASH',
    ],
    default: 'registry neo_n3.contracts.morpheus_oracle',
    required: false,
    description:
      'Neo N3 oracle contract hash (network-scoped alias preferred). Required for the Neo N3 request lane.',
  },
  {
    key: 'neo_n3.datafeedContract',
    aliases: [
      'CONTRACT_MORPHEUS_DATAFEED_HASH_MAINNET',
      'CONTRACT_MORPHEUS_DATAFEED_HASH_TESTNET',
      'CONTRACT_MORPHEUS_DATAFEED_HASH',
    ],
    default: 'registry neo_n3.contracts.morpheus_datafeed',
    required: false,
    description: 'Neo N3 datafeed contract hash (network-scoped alias preferred).',
  },

  // --- Neo N3 fee top-up ---
  {
    key: 'neo_n3.feeTopUp.enabled',
    aliases: ['MORPHEUS_RELAYER_NEO_N3_AUTO_TOPUP_ENABLED'],
    default: 'true',
    required: false,
    description: 'Auto fee top-up of the Neo N3 updater on/off.',
  },
  {
    key: 'neo_n3.feeTopUp.minBalance',
    aliases: ['MORPHEUS_RELAYER_NEO_N3_AUTO_TOPUP_MIN_FIXED8'],
    default: '50000000',
    required: false,
    description: 'GAS balance (fixed8) below which top-up triggers.',
  },
  {
    key: 'neo_n3.feeTopUp.topUpAmount',
    aliases: ['MORPHEUS_RELAYER_NEO_N3_AUTO_TOPUP_AMOUNT_FIXED8'],
    default: '100000000',
    required: false,
    description: 'GAS amount (fixed8) per top-up.',
  },
  {
    key: 'neo_n3.feeTopUp.maxTopUpAmount',
    aliases: ['MORPHEUS_RELAYER_NEO_N3_AUTO_TOPUP_MAX_FIXED8'],
    default: '500000000',
    required: false,
    description: 'Max cumulative top-up amount (fixed8).',
  },
  {
    key: 'neo_n3.custodyKeyIds.fee_funder',
    aliases: ['SIGNER_ROLE_FEE_FUNDER_KEY_ID'],
    default: '(unset)',
    required: false,
    description:
      'Custody key id funding updater fee top-ups; required only if auto top-up is enabled and the updater needs funding.',
  },

  // --- Nitro / enclave ---
  {
    key: 'nitro.apiUrl',
    aliases: [
      'MORPHEUS_MAINNET_RUNTIME_URL',
      'MORPHEUS_TESTNET_RUNTIME_URL',
      'MORPHEUS_RUNTIME_URL',
      'MORPHEUS_MAINNET_NITRO_API_URL',
      'MORPHEUS_TESTNET_NITRO_API_URL',
      'NITRO_API_URL',
    ],
    default: 'development: public oracle/edge fallbacks; production: unset',
    required: false,
    description:
      'Nitro worker API URL(s); production confidential calls require an explicit URL and use only the first endpoint.',
  },
  {
    key: 'nitro.allowFallback',
    aliases: ['MORPHEUS_RELAYER_ALLOW_RUNTIME_FALLBACKS'],
    default: 'true outside production; false in production',
    required: false,
    description:
      'Development migration switch for Nitro endpoint failover; production ignores it and fails closed on the primary endpoint.',
  },
  {
    key: 'nitro.signerUrl',
    aliases: ['NITRO_SIGNER_URL', 'MORPHEUS_SIGNER_URL'],
    default: 'falls back to nitro.apiUrl',
    required: false,
    description:
      'Frontier/legacy signer URL. Neo N3 private keys live in the separate custody service, not this relayer-facing configuration.',
  },
  {
    key: 'nitro.custodyUrl',
    aliases: ['SIGNER_SERVICE_URL'],
    default: '(unset)',
    required: false,
    description:
      'Custody signer service base URL; all relayer Neo N3 signing goes through it. Required for the Neo N3 request lane.',
  },
  {
    key: 'nitro.custodyToken',
    aliases: ['SIGNER_SERVICE_TOKEN'],
    default: '(unset)',
    required: false,
    secret: true,
    description: 'Bearer token for the custody signer service API.',
  },
  {
    key: 'nitro.enclaveFulfill',
    aliases: ['MORPHEUS_RELAYER_ENCLAVE_FULFILL'],
    default: 'false',
    required: false,
    description: 'Compute-in-enclave cutover flag (atomic POST /oracle/fulfill).',
  },
  {
    key: 'nitro.expectedPcr0',
    aliases: ['MORPHEUS_EXPECTED_PCR0'],
    default: '(unset, no PCR0 pinning)',
    required: false,
    description: 'Expected enclave PCR0 (hex) for attestation binding.',
  },
  {
    key: 'nitro.verifyEnclaveSignature',
    aliases: ['MORPHEUS_RELAYER_VERIFY_ENCLAVE_SIGNATURE'],
    default: 'false',
    required: false,
    description: 'Verify enclave signature against the on-chain oracle_verifier key before submit.',
  },
  {
    key: 'nitro.enclaveFulfillUrl',
    aliases: ['MORPHEUS_RELAYER_ENCLAVE_FULFILL_URL'],
    default: 'falls back to signer URL / apiUrl',
    required: false,
    description: 'Enclave /oracle/fulfill base URL.',
  },
  {
    key: 'nitro.decryptUrl',
    aliases: ['MORPHEUS_RELAYER_ENCLAVE_DECRYPT_URL', 'MORPHEUS_DECRYPT_URL'],
    default: 'falls back to enclave-fulfill / signer / apiUrl',
    required: false,
    description: 'Enclave-only confidential /oracle/decrypt URL (never fails over).',
  },
  {
    key: 'nitro.nitroRootCertPem',
    aliases: ['MORPHEUS_NITRO_ROOT_CERT_PEM'],
    default: 'falls back to file at MORPHEUS_NITRO_ROOT_CERT_PATH',
    required: false,
    secret: true,
    description: 'PEM of the pinned AWS Nitro attestation root cert (inline).',
  },
  {
    key: 'nitro.nitroRootCertPath',
    aliases: ['MORPHEUS_NITRO_ROOT_CERT_PATH'],
    default: '(unset)',
    required: false,
    description: 'Path to the pinned AWS Nitro attestation root cert PEM file.',
  },
  {
    key: 'nitro.attestationMaxAgeMs',
    aliases: ['MORPHEUS_ATTESTATION_MAX_AGE_MS'],
    default: '0 (timestamp-age gate disabled)',
    required: false,
    description: 'Max age of an attestation document timestamp before stale (ms).',
  },
  {
    key: 'nitro.token',
    aliases: ['MORPHEUS_RUNTIME_TOKEN', 'NITRO_API_TOKEN', 'NITRO_SHARED_SECRET'],
    default: '(unset)',
    required: false,
    secret: true,
    description: 'Shared secret / bearer token for the Nitro worker + enclave.',
  },
  {
    key: 'nitro.timeoutMs',
    aliases: ['MORPHEUS_NITRO_TIMEOUT_MS'],
    default: '10000',
    required: false,
    description: 'Nitro request timeout (ms, clamped 1000..10000).',
  },

  // --- Neo X ---
  {
    key: 'neox.scanMode',
    aliases: ['MORPHEUS_RELAYER_NEOX_SCAN_MODE'],
    default: 'request_cursor',
    required: false,
    description: 'Neo X discovery scan mode.',
  },
  {
    key: 'neox.rpcUrl',
    aliases: ['MORPHEUS_RELAYER_NEOX_RPC_URL', 'NEOX_RPC'],
    default: 'registry neox.rpc_url or per-net public default',
    required: false,
    description:
      'Neo X primary RPC URL (signer/submit path stays pinned here). Required for the Neo X lane.',
  },
  {
    key: 'neox.rpcUrls',
    aliases: ['MORPHEUS_RELAYER_NEOX_RPC_URLS', 'NEOX_RPC_URLS'],
    default: 'per-net public defaults appended after primary',
    required: false,
    description: 'Neo X read-failover RPC list.',
  },
  {
    key: 'neox.chainId',
    aliases: ['MORPHEUS_RELAYER_NEOX_CHAIN_ID', 'NEOX_CHAIN_ID'],
    default: '47763 (mainnet) / 12227332 (testnet)',
    required: false,
    description: 'Neo X chain id (bound into the fulfillment digest).',
  },
  {
    key: 'neox.oracleContract',
    aliases: ['MORPHEUS_RELAYER_NEOX_ORACLE', 'NEOX_ORACLE'],
    default: 'registry neox.contracts.morpheus_oracle',
    required: false,
    description: 'Neo X oracle contract address. Required for the Neo X lane.',
  },
  {
    key: 'neox.updaterPrivateKey',
    aliases: ['MORPHEUS_RELAYER_NEOX_UPDATER_PK', 'NEOX_UPDATER_PK', 'NEOX_FEED_PK'],
    default: '(unset)',
    required: false,
    secret: true,
    description: 'Neo X updater secp256k1 private key. Required for the Neo X submit path.',
  },
  {
    key: 'neox.verifierPrivateKey',
    aliases: ['MORPHEUS_RELAYER_NEOX_VERIFIER_PK', 'NEOX_VERIFIER_PK'],
    default: '(unset)',
    required: false,
    secret: true,
    description: 'Neo X verifier secp256k1 private key.',
  },
  {
    key: 'neox.confirmTimeoutMs',
    aliases: ['MORPHEUS_RELAYER_NEOX_CONFIRM_TIMEOUT_MS'],
    default: '45000',
    required: false,
    description: 'Neo X fulfillRequest receipt-wait deadline (ms, min 1000).',
  },
  {
    key: 'neox.workerUrl',
    aliases: ['MORPHEUS_RELAYER_NEOX_WORKER_URL', 'NEOX_WORKER_URL'],
    default: '(unset)',
    required: false,
    description: 'Neo X worker URL.',
  },

  // --- Metrics server ---
  {
    key: 'metricsServer.host',
    aliases: ['MORPHEUS_RELAYER_METRICS_HOST'],
    default: '127.0.0.1',
    required: false,
    description: 'Metrics server bind host.',
  },
  {
    key: 'metricsServer.port',
    aliases: ['MORPHEUS_RELAYER_METRICS_PORT'],
    default: '9464',
    required: false,
    description: 'Metrics server port (min 1).',
  },
  {
    key: 'metricsServer.path',
    aliases: ['MORPHEUS_RELAYER_METRICS_PATH'],
    default: '/metrics',
    required: false,
    description: 'Metrics server scrape path.',
  },

  // --- Heartbeats / alerting ---
  {
    key: 'heartbeats.relayer',
    aliases: ['MORPHEUS_BETTERSTACK_RELAYER_HEARTBEAT_URL'],
    default: '(unset)',
    required: false,
    description: 'BetterStack heartbeat URL for the request relayer.',
  },
  {
    key: 'heartbeats.feedRelayer',
    aliases: ['MORPHEUS_BETTERSTACK_RELAYER_FEED_HEARTBEAT_URL'],
    default: '(unset)',
    required: false,
    description: 'BetterStack heartbeat URL for the feed relayer.',
  },
  {
    key: 'heartbeats.failure',
    aliases: ['MORPHEUS_BETTERSTACK_RELAYER_FAILURE_URL'],
    default: '(unset)',
    required: false,
    description: 'BetterStack failure push-alert URL.',
  },
  {
    key: 'heartbeats.deadLetter',
    aliases: ['MORPHEUS_BETTERSTACK_RELAYER_DEADLETTER_URL'],
    default: 'falls back to heartbeats.failure',
    required: false,
    description: 'BetterStack dead-letter push-alert URL.',
  },

  // --- Neo N3 custody signer keys (docs/SIGNER_SERVICE.md §5) ---
  {
    key: 'neo_n3.custodyKeyIds.updater',
    aliases: ['SIGNER_ROLE_UPDATER_KEY_ID'],
    default: '(unset)',
    required: false,
    description:
      'Custody key id signing fulfillRequest/queueAutomationRequest transactions. ' +
      'Required when neo_n3 is active AND mode is not feed_only.',
  },
  {
    key: 'neo_n3.custodyKeyIds.oracle_verifier',
    aliases: ['SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID'],
    default: '(unset)',
    required: false,
    description:
      'Custody key id signing fulfillment result payloads; its public key must match the on-chain-pinned oracle_verifier.',
  },

  // --- Runtime config packing ---
  {
    key: 'runtimeConfigJson',
    aliases: ['MORPHEUS_RUNTIME_CONFIG_JSON'],
    default: '(unset)',
    required: false,
    secret: true,
    description:
      'JSON object of packed env values; consulted by env() as a fallback after process.env. Treated as secret (may contain keys/tokens).',
  },
];

// Every env alias that the schema knows about (deduped), used by the
// typo-detector to decide whether a MORPHEUS_*/NITRO_* var is unknown.
export function knownEnvAliases() {
  const known = new Set(DIRECT_CONTROL_ENV_KEYS);
  for (const setting of CONFIG_SCHEMA) {
    for (const alias of setting.aliases) known.add(alias);
  }
  return known;
}
