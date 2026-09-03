use prometheus::{
    register_counter_vec, register_histogram_vec, register_int_counter_vec,
    register_int_gauge, CounterVec, HistogramVec, IntCounterVec, IntGauge,
};
use std::sync::LazyLock;

/// Total number of signing requests received
pub static SIGN_REQUESTS_TOTAL: LazyLock<IntCounterVec> = LazyLock::new(|| {
    register_int_counter_vec!(
        "neo_signer_sign_requests_total",
        "Total number of signing requests",
        &["chain_family", "result"]
    )
    .unwrap()
});

/// Total number of key generation requests
pub static KEY_GEN_REQUESTS_TOTAL: LazyLock<IntCounterVec> = LazyLock::new(|| {
    register_int_counter_vec!(
        "neo_signer_key_gen_requests_total",
        "Total number of key generation requests",
        &["result"]
    )
    .unwrap()
});

/// Total number of policy evaluations
pub static POLICY_EVALUATIONS_TOTAL: LazyLock<IntCounterVec> = LazyLock::new(|| {
    register_int_counter_vec!(
        "neo_signer_policy_evaluations_total",
        "Total number of policy evaluations",
        &["result"]
    )
    .unwrap()
});

/// Total number of policy violations by type
pub static POLICY_VIOLATIONS_TOTAL: LazyLock<IntCounterVec> = LazyLock::new(|| {
    register_int_counter_vec!(
        "neo_signer_policy_violations_total",
        "Total number of policy violations",
        &["reason"]
    )
    .unwrap()
});

/// Request duration histogram
pub static REQUEST_DURATION_SECONDS: LazyLock<HistogramVec> = LazyLock::new(|| {
    register_histogram_vec!(
        "neo_signer_request_duration_seconds",
        "Request duration in seconds",
        &["endpoint", "method"],
        vec![0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0, 5.0]
    )
    .unwrap()
});

/// Signing operation duration histogram
pub static SIGN_DURATION_SECONDS: LazyLock<HistogramVec> = LazyLock::new(|| {
    register_histogram_vec!(
        "neo_signer_sign_duration_seconds",
        "Signing operation duration in seconds",
        &["chain_family"],
        vec![0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1]
    )
    .unwrap()
});

/// Number of active keys in custody
pub static ACTIVE_KEYS_COUNT: LazyLock<IntGauge> = LazyLock::new(|| {
    register_int_gauge!(
        "neo_signer_active_keys_count",
        "Number of active keys in custody"
    )
    .unwrap()
});

/// Total number of attestation requests
pub static ATTESTATION_REQUESTS_TOTAL: LazyLock<IntCounterVec> = LazyLock::new(|| {
    register_int_counter_vec!(
        "neo_signer_attestation_requests_total",
        "Total number of attestation requests",
        &["result"]
    )
    .unwrap()
});

/// Database operation duration histogram
pub static DB_OPERATION_DURATION_SECONDS: LazyLock<HistogramVec> = LazyLock::new(|| {
    register_histogram_vec!(
        "neo_signer_db_operation_duration_seconds",
        "Database operation duration in seconds",
        &["operation"],
        vec![0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1]
    )
    .unwrap()
});

/// Total bytes processed in signing operations
pub static SIGN_BYTES_TOTAL: LazyLock<CounterVec> = LazyLock::new(|| {
    register_counter_vec!(
        "neo_signer_sign_bytes_total",
        "Total bytes processed in signing operations",
        &["chain_family"]
    )
    .unwrap()
});

/// Window limit tracking - transfers in current window
pub static WINDOW_TRANSFER_AMOUNT: LazyLock<HistogramVec> = LazyLock::new(|| {
    register_histogram_vec!(
        "neo_signer_window_transfer_amount",
        "Transfer amounts in current window",
        &["key_id"],
        vec![1.0, 10.0, 100.0, 1000.0, 10000.0, 100000.0]
    )
    .unwrap()
});

/// Initialize all metrics (forces lazy evaluation)
pub fn init_metrics() {
    LazyLock::force(&SIGN_REQUESTS_TOTAL);
    LazyLock::force(&KEY_GEN_REQUESTS_TOTAL);
    LazyLock::force(&POLICY_EVALUATIONS_TOTAL);
    LazyLock::force(&POLICY_VIOLATIONS_TOTAL);
    LazyLock::force(&REQUEST_DURATION_SECONDS);
    LazyLock::force(&SIGN_DURATION_SECONDS);
    LazyLock::force(&ACTIVE_KEYS_COUNT);
    LazyLock::force(&ATTESTATION_REQUESTS_TOTAL);
    LazyLock::force(&DB_OPERATION_DURATION_SECONDS);
    LazyLock::force(&SIGN_BYTES_TOTAL);
    LazyLock::force(&WINDOW_TRANSFER_AMOUNT);
}
