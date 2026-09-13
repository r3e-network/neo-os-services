//! Prometheus metrics exposition, queue-age/latency gauges, and metrics HTTP server.
//!
//! Pinned byte-for-byte against `workers/morpheus-relayer/src/prometheus.js` and
//! `metrics-server.js`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use neo_os_core::js_number::number_to_string;
use neo_os_core::state::{parse_iso_date_ms, LABELED_FAILURE_DELIMITER};
use serde_json::Value;

/// F7: Process-global atomic counter for log sink dropped entries.
pub static LOG_SINK_DROPPED_TOTAL: AtomicU64 = AtomicU64::new(0);

pub fn get_log_sink_dropped_total() -> u64 {
    LOG_SINK_DROPPED_TOTAL.load(Ordering::Relaxed)
}

pub fn increment_log_sink_dropped_total(by: u64) {
    LOG_SINK_DROPPED_TOTAL.fetch_add(by, Ordering::Relaxed);
}

pub fn reset_log_sink_dropped_total_for_tests() {
    LOG_SINK_DROPPED_TOTAL.store(0, Ordering::Relaxed);
}

/// Flat top-level counters rendered as Prometheus `counter` series.
/// Exactly 25 counters as specified in ARCHITECTURE.md §5.2.
pub const TOP_LEVEL_COUNTERS: &[&str] = &[
    "ticks_total",
    "events_scanned_total",
    "events_processed_total",
    "events_failed_total",
    "duplicates_skipped_total",
    "retries_scheduled_total",
    "retries_exhausted_total",
    "worker_calls_total",
    "worker_failures_total",
    "fulfill_success_total",
    "fulfill_failure_total",
    "claim_conflicts_total",
    "stale_reclaims_total",
    "discovery_failures_total",
    "discovery_idle_skips_total",
    "reconciliation_failures_total",
    "durable_claim_skipped_during_backoff_total",
    "manual_actions_loaded_total",
    "feed_sync_runs_total",
    "feed_sync_success_total",
    "feed_sync_error_total",
    "feed_sync_skipped_total",
    "backpressure_deferred_total",
    "backpressure_retry_skipped_total",
    "retry_queue_overflow_total",
];

/// Render a single metric line. Returns None if value is not finite.
pub fn metric_line(name: &str, value: f64, labels: Option<&[(&str, &str)]>) -> Option<String> {
    if !value.is_finite() {
        return None;
    }
    let suffix = match labels {
        Some(entries) if !entries.is_empty() => {
            let inner = entries
                .iter()
                .map(|(k, v)| format!("{k}=\"{}\"", v.replace('"', "\\\"")))
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{inner}}}")
        }
        _ => String::new(),
    };
    Some(format!("{name}{suffix} {}", number_to_string(value)))
}

fn parse_iso_to_unix_seconds(value: Option<&Value>) -> Option<i64> {
    let s = value.and_then(|v| v.as_str())?;
    let ms = parse_iso_date_ms(s)?;
    Some((ms / 1000.0).floor() as i64)
}

fn num_val(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => s.parse::<f64>().unwrap_or(0.0),
        _ => 0.0,
    }
}

/// Render Prometheus text exposition matching `workers/morpheus-relayer/src/prometheus.js`.
pub fn render_prometheus_metrics(metrics: &Value) -> String {
    let mut lines: Vec<String> = vec![
        "# HELP morpheus_relayer_ticks_total Total relayer ticks processed.".to_string(),
        "# TYPE morpheus_relayer_ticks_total counter".to_string(),
    ];

    for name in TOP_LEVEL_COUNTERS {
        let val = num_val(metrics.get(*name));
        if let Some(line) = metric_line(&format!("morpheus_relayer_{name}"), val, None) {
            lines.push(line);
        }
    }

    let gauges = ["last_feed_sync_duration_ms", "last_tick_duration_ms"];
    for name in gauges {
        let val = num_val(metrics.get(name));
        if let Some(line) = metric_line(&format!("morpheus_relayer_{name}"), val, None) {
            lines.push(line);
        }
    }

    // F2: last-fulfill latency gauge.
    if let Some(val) = metrics.get("last_fulfill_latency_ms") {
        if !val.is_null() {
            if let Some(n) = val.as_f64() {
                if n.is_finite() {
                    if let Some(line) =
                        metric_line("morpheus_relayer_last_fulfill_latency_ms", n, None)
                    {
                        lines.push(line);
                    }
                }
            }
        }
    }

    // F2: per-chain queue-age gauges.
    if let Some(Value::Object(map)) = metrics.get("oldest_retry_age_seconds") {
        for (chain, val) in map {
            if !val.is_null() {
                if let Some(n) = val.as_f64() {
                    if let Some(line) = metric_line(
                        "morpheus_relayer_oldest_retry_age_seconds",
                        n,
                        Some(&[("chain", chain.as_str())]),
                    ) {
                        lines.push(line);
                    }
                }
            }
        }
    }

    if let Some(Value::Object(map)) = metrics.get("oldest_dead_letter_age_seconds") {
        for (chain, val) in map {
            if !val.is_null() {
                if let Some(n) = val.as_f64() {
                    if let Some(line) = metric_line(
                        "morpheus_relayer_oldest_dead_letter_age_seconds",
                        n,
                        Some(&[("chain", chain.as_str())]),
                    ) {
                        lines.push(line);
                    }
                }
            }
        }
    }

    let timestamp_gauges = [
        (
            "last_feed_sync_started_at",
            "morpheus_relayer_last_feed_sync_started_at_seconds",
        ),
        (
            "last_feed_sync_completed_at",
            "morpheus_relayer_last_feed_sync_completed_at_seconds",
        ),
        (
            "last_feed_sync_success_at",
            "morpheus_relayer_last_feed_sync_success_at_seconds",
        ),
        (
            "last_tick_started_at",
            "morpheus_relayer_last_tick_started_at_seconds",
        ),
        (
            "last_tick_completed_at",
            "morpheus_relayer_last_tick_completed_at_seconds",
        ),
    ];

    for (field, metric_name) in timestamp_gauges {
        if let Some(secs) = parse_iso_to_unix_seconds(metrics.get(field)) {
            if let Some(line) = metric_line(metric_name, secs as f64, None) {
                lines.push(line);
            }
        }
    }

    if let Some(Value::Object(map)) = metrics.get("retry_queue_sizes") {
        for (chain, val) in map {
            let n = num_val(Some(val));
            if let Some(line) = metric_line(
                "morpheus_relayer_retry_queue_size",
                n,
                Some(&[("chain", chain.as_str())]),
            ) {
                lines.push(line);
            }
        }
    }

    if let Some(Value::Object(map)) = metrics.get("dead_letter_sizes") {
        for (chain, val) in map {
            let n = num_val(Some(val));
            if let Some(line) = metric_line(
                "morpheus_relayer_dead_letter_size",
                n,
                Some(&[("chain", chain.as_str())]),
            ) {
                lines.push(line);
            }
        }
    }

    if let Some(Value::Object(map)) = metrics.get("checkpoints") {
        for (chain, val) in map {
            if let Some(n) = val
                .as_f64()
                .or_else(|| val.as_str().and_then(|s| s.parse().ok()))
            {
                if n.is_finite() {
                    if let Some(line) = metric_line(
                        "morpheus_relayer_chain_checkpoint",
                        n,
                        Some(&[("chain", chain.as_str())]),
                    ) {
                        lines.push(line);
                    }
                }
            }
        }
    }

    if let Some(Value::Object(map)) = metrics.get("request_checkpoints") {
        for (chain, val) in map {
            if let Some(n) = val
                .as_f64()
                .or_else(|| val.as_str().and_then(|s| s.parse().ok()))
            {
                if n.is_finite() {
                    if let Some(line) = metric_line(
                        "morpheus_relayer_request_checkpoint",
                        n,
                        Some(&[("chain", chain.as_str())]),
                    ) {
                        lines.push(line);
                    }
                }
            }
        }
    }

    // F5: labeled failure counters {chain, module, operation}.
    if let Some(val) = metrics.get("labeled_failures") {
        match val {
            Value::Array(arr) => {
                for item in arr {
                    let chain = item
                        .get("chain")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown");
                    let module = item
                        .get("module")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown");
                    let operation = item
                        .get("operation")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown");
                    let v = num_val(item.get("value"));
                    if let Some(line) = metric_line(
                        "morpheus_relayer_failures_total",
                        v,
                        Some(&[
                            ("chain", chain),
                            ("module", module),
                            ("operation", operation),
                        ]),
                    ) {
                        lines.push(line);
                    }
                }
            }
            Value::Object(map) => {
                for (key, v_val) in map {
                    let parts: Vec<&str> = key.split(LABELED_FAILURE_DELIMITER).collect();
                    let chain = parts.first().copied().unwrap_or("unknown");
                    let module = parts.get(1).copied().unwrap_or("unknown");
                    let operation = parts.get(2).copied().unwrap_or("unknown");
                    let v = num_val(Some(v_val));
                    if let Some(line) = metric_line(
                        "morpheus_relayer_failures_total",
                        v,
                        Some(&[
                            ("chain", chain),
                            ("module", module),
                            ("operation", operation),
                        ]),
                    ) {
                        lines.push(line);
                    }
                }
            }
            _ => {}
        }
    }

    // F7: Betterstack log-sink drop counter
    let log_sink_dropped = if let Some(n) = metrics
        .get("log_sink_dropped_total")
        .and_then(|v| v.as_f64())
    {
        if n.is_finite() {
            n
        } else {
            get_log_sink_dropped_total() as f64
        }
    } else {
        get_log_sink_dropped_total() as f64
    };
    if let Some(line) = metric_line(
        "morpheus_relayer_log_sink_dropped_total",
        log_sink_dropped,
        None,
    ) {
        lines.push(line);
    }

    // XCM lane counters. Rendered only when the corresponding metric field is
    // present, so the byte-identical 25-counter parity block above is unchanged
    // for oracle-only deployments that never touch the cross-chain lane. Only
    // counters the tick actually increments are listed: there is no dead metric
    // infrastructure. (`xcm_messages_enqueued_total` was removed because the
    // enqueue path is not invoked from the tick and has no metrics state to
    // increment, so it could never render.)
    const XCM_COUNTERS: &[&str] = &[
        "xcm_messages_relayed_total",
        "xcm_messages_failed_total",
        "xcm_claim_conflicts_total",
    ];
    for name in XCM_COUNTERS {
        if let Some(val) = metrics.get(*name) {
            if !val.is_null() {
                if let Some(line) = metric_line(
                    &format!("morpheus_relayer_{name}"),
                    num_val(Some(val)),
                    None,
                ) {
                    lines.push(line);
                }
            }
        }
    }

    let mut out = lines.join("\n");
    out.push('\n');
    out
}

#[derive(Clone)]
pub struct MetricsServerState {
    pub state_file: String,
    pub metrics_path: String,
}

async fn handle_metrics(State(st): State<Arc<MetricsServerState>>) -> Response {
    let state_file = st.state_file.clone();
    let metrics_value = tokio::task::spawn_blocking(move || {
        std::fs::read_to_string(state_file)
            .ok()
            .and_then(|content| serde_json::from_str::<Value>(&content).ok())
            .and_then(|json| json.get("metrics").cloned())
            .unwrap_or(Value::Null)
    })
    .await
    .unwrap_or(Value::Null);

    let rendered = render_prometheus_metrics(&metrics_value);
    (
        StatusCode::OK,
        [
            (
                header::CONTENT_TYPE,
                "text/plain; version=0.0.4; charset=utf-8",
            ),
            (header::CACHE_CONTROL, "no-store"),
        ],
        rendered,
    )
        .into_response()
}

async fn handle_healthz(State(st): State<Arc<MetricsServerState>>) -> Response {
    let body = serde_json::json!({
        "status": "ok",
        "service": "morpheus-relayer-metrics",
        "metrics_path": st.metrics_path,
    });
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        body.to_string(),
    )
        .into_response()
}

async fn handle_fallback() -> Response {
    (
        StatusCode::NOT_FOUND,
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        "not found\n",
    )
        .into_response()
}

/// Start Prometheus metrics HTTP server with Axum.
pub async fn start_metrics_server(
    host: &str,
    port: u16,
    metrics_path: &str,
    state_file: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let st = Arc::new(MetricsServerState {
        state_file: state_file.to_string(),
        metrics_path: metrics_path.to_string(),
    });

    let app = Router::new()
        .route(metrics_path, get(handle_metrics))
        .route("/healthz", get(handle_healthz))
        .fallback(handle_fallback)
        .with_state(st);

    let addr_str = format!("{host}:{port}");
    let listener = tokio::net::TcpListener::bind(&addr_str).await?;
    tracing::info!(
        host = host,
        port = port,
        metrics_path = metrics_path,
        health_path = "/healthz",
        "Started relayer metrics server"
    );
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let reason = neo_os_service_runtime::shutdown_signal().await;
            tracing::info!(?reason, "Stopping relayer metrics server");
        })
        .await?;
    Ok(())
}
