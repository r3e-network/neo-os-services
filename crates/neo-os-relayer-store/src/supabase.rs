//! Supabase REST client (PostgREST) with error classification,
//! PostgreSQL NUL sanitization, and dual-tier backoff state machine (T03).
//!
//! Ported directly from `workers/morpheus-relayer/src/persistence.js:20-235`.

use serde_json::Value;
use std::sync::{Arc, Mutex};
use url::Url;

use crate::HttpTransport;

pub const DEFAULT_QUOTA_BACKOFF_MS: u64 = 300_000; // 5 minutes
pub const DEFAULT_TRANSIENT_BACKOFF_MS: u64 = 30_000; // 30 seconds

/// Sanitize values destined for PostgreSQL: Postgres text/jsonb columns
/// reject `\u0000` (NUL bytes).
pub fn sanitize_for_postgres(value: &Value) -> Value {
    match value {
        Value::String(s) => Value::String(s.replace('\0', "")),
        Value::Array(arr) => Value::Array(arr.iter().map(sanitize_for_postgres).collect()),
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                out.insert(k.clone(), sanitize_for_postgres(v));
            }
            Value::Object(out)
        }
        _ => value.clone(),
    }
}

/// Check if an error message indicates a database storage/quota restriction (HTTP 402).
pub fn is_supabase_quota_restricted_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("exceed_db_size_quota")
        || lower.contains("database size quota")
        || lower.contains("quota exceeded")
        || lower.contains("402 payment required")
        || lower.contains("failed: 402")
}

/// Check if an error indicates a transient connectivity/5xx/timeout outage
/// (and NOT a quota restriction).
pub fn is_supabase_connectivity_error(error: &str) -> bool {
    if is_supabase_quota_restricted_error(error) {
        return false;
    }
    let lower = error.to_ascii_lowercase();
    lower.contains("pgrst002")
        || lower.contains("schema cache")
        || lower.contains("failed: 503")
        || lower.contains("failed: 502")
        || lower.contains("failed: 504")
        || lower.contains(" 503 ")
        || lower.contains(" 502 ")
        || lower.contains(" 504 ")
        || lower.contains("timed out")
        || lower.contains("timeout")
        || lower.contains("econnreset")
        || lower.contains("econnrefused")
        || lower.contains("eauthquery")
        || lower.contains("connection to database not available")
        || lower.contains("fetch failed")
        || lower.contains("network")
        || lower.contains("unavailable")
}

/// Transient durable queue error predicate: both quota and connectivity errors
/// trigger retry and fallback (matches queue.js:332-355).
pub fn is_transient_durable_queue_error(error: &str) -> bool {
    if is_supabase_quota_restricted_error(error) || is_supabase_connectivity_error(error) {
        return true;
    }
    let lower = error.to_ascii_lowercase();
    lower.contains("502") || lower.contains("503") || lower.contains("504")
}

/// Backoff state details.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackoffInfo {
    pub active: bool,
    pub reason: String,
    pub until_ms: u64,
    pub remaining_ms: u64,
}

/// Dual-tier backoff state machine (quota 5m / connectivity 30s).
#[derive(Debug, Clone, Default)]
pub struct BackoffState {
    pub backoff_until_ms: u64,
    pub backoff_reason: String,
    pub quota_duration_ms: u64,
    pub transient_duration_ms: u64,
}

impl BackoffState {
    pub fn new() -> Self {
        Self {
            backoff_until_ms: 0,
            backoff_reason: String::new(),
            quota_duration_ms: DEFAULT_QUOTA_BACKOFF_MS,
            transient_duration_ms: DEFAULT_TRANSIENT_BACKOFF_MS,
        }
    }

    pub fn with_durations(quota_ms: u64, transient_ms: u64) -> Self {
        Self {
            backoff_until_ms: 0,
            backoff_reason: String::new(),
            quota_duration_ms: quota_ms,
            transient_duration_ms: transient_ms,
        }
    }

    /// Mark persistence unavailable based on an error message.
    /// Returns true if a backoff window was armed.
    pub fn mark_unavailable(&mut self, error: &str, now_ms: u64) -> bool {
        if is_supabase_quota_restricted_error(error) {
            let next_until = now_ms + self.quota_duration_ms;
            if next_until > self.backoff_until_ms {
                self.backoff_until_ms = next_until;
            }
            self.backoff_reason = "quota_restricted".into();
            return true;
        }
        if is_supabase_connectivity_error(error) {
            let next_until = now_ms + self.transient_duration_ms;
            // Never shorten an already-armed (possibly longer, quota) window.
            if next_until > self.backoff_until_ms {
                self.backoff_until_ms = next_until;
                // Keep quota reason sticky if still active.
                if self.backoff_reason != "quota_restricted" {
                    self.backoff_reason = "connectivity".into();
                }
            }
            return true;
        }
        false
    }

    pub fn get_backoff(&self, now_ms: u64) -> Option<BackoffInfo> {
        if self.backoff_until_ms <= now_ms {
            return None;
        }
        Some(BackoffInfo {
            active: true,
            reason: if self.backoff_reason.is_empty() {
                "temporarily_unavailable".into()
            } else {
                self.backoff_reason.clone()
            },
            until_ms: self.backoff_until_ms,
            remaining_ms: self.backoff_until_ms - now_ms,
        })
    }

    pub fn should_skip(&self, now_ms: u64) -> bool {
        self.backoff_until_ms > now_ms
    }

    pub fn reset(&mut self) {
        self.backoff_until_ms = 0;
        self.backoff_reason.clear();
    }
}

/// Request options for PostgREST calls.
#[derive(Debug, Clone, Default)]
pub struct RequestOptions {
    pub query: Vec<(String, String)>,
    pub on_conflict: Option<String>,
    pub ignore_duplicates: bool,
    pub return_representation: bool,
}

#[derive(Debug, Clone)]
pub struct SupabaseConfig {
    pub rest_url: String,
    pub api_key: String,
    pub network: String,
}

impl SupabaseConfig {
    pub fn new(base_url: &str, api_key: &str, network: &str) -> Self {
        let trimmed = base_url.trim().trim_end_matches('/');
        let rest_url = if trimmed.ends_with("/rest/v1") {
            trimmed.to_string()
        } else {
            format!("{trimmed}/rest/v1")
        };
        Self {
            rest_url,
            api_key: api_key.trim().to_string(),
            network: if network.trim() == "mainnet" {
                "mainnet".into()
            } else {
                "testnet".into()
            },
        }
    }
}

/// Supabase REST client wrapping an injected transport and shared backoff state.
pub struct SupabaseClient<T: HttpTransport> {
    transport: T,
    config: SupabaseConfig,
    backoff: Arc<Mutex<BackoffState>>,
}

impl<T: HttpTransport> SupabaseClient<T> {
    pub fn new(transport: T, config: SupabaseConfig) -> Self {
        Self {
            transport,
            config,
            backoff: Arc::new(Mutex::new(BackoffState::new())),
        }
    }

    pub fn with_backoff(
        transport: T,
        config: SupabaseConfig,
        backoff: Arc<Mutex<BackoffState>>,
    ) -> Self {
        Self {
            transport,
            config,
            backoff,
        }
    }

    pub fn config(&self) -> &SupabaseConfig {
        &self.config
    }

    pub fn backoff(&self) -> Arc<Mutex<BackoffState>> {
        self.backoff.clone()
    }

    pub fn is_backed_off(&self, now_ms: u64) -> bool {
        self.backoff.lock().unwrap().should_skip(now_ms)
    }

    /// Execute a low-level REST request against a Supabase table.
    pub fn request(
        &self,
        table: &str,
        method: &str,
        payload: Option<&Value>,
        options: &RequestOptions,
        now_ms: u64,
    ) -> Result<String, String> {
        if self.is_backed_off(now_ms) {
            return Err("supabase persistence unavailable during backoff".into());
        }

        let full_url_str = format!("{}/{}", self.config.rest_url.trim_end_matches('/'), table);
        let mut url =
            Url::parse(&full_url_str).map_err(|e| format!("invalid URL {full_url_str}: {e}"))?;

        if let Some(on_conflict) = &options.on_conflict {
            url.query_pairs_mut()
                .append_pair("on_conflict", on_conflict);
        }
        for (k, v) in &options.query {
            if !k.is_empty() && !v.is_empty() {
                url.query_pairs_mut().append_pair(k, v);
            }
        }

        let auth_header = format!("Bearer {}", self.config.api_key);
        let mut headers = vec![
            ("apikey", self.config.api_key.as_str()),
            ("authorization", auth_header.as_str()),
            ("accept", "application/json"),
        ];

        let mut prefer_tokens = Vec::new();
        let resolution_str;
        if options.on_conflict.is_some() {
            let res = if options.ignore_duplicates {
                "resolution=ignore-duplicates"
            } else {
                "resolution=merge-duplicates"
            };
            resolution_str = res.to_string();
            prefer_tokens.push(resolution_str.as_str());
        }
        if options.return_representation {
            prefer_tokens.push("return=representation");
        }
        let prefer_header_val = prefer_tokens.join(",");
        if !prefer_tokens.is_empty() {
            headers.push(("Prefer", &prefer_header_val));
        }

        let body_str;
        if let Some(data) = payload {
            headers.push(("content-type", "application/json"));
            body_str = serde_json::to_string(&sanitize_for_postgres(data))
                .map_err(|e| format!("serialize error: {e}"))?;
        } else {
            body_str = String::new();
        }

        let (status, raw) = self.transport.request(
            method,
            url.as_str(),
            &headers,
            if payload.is_some() {
                Some(&body_str)
            } else {
                None
            },
        )?;

        if !(200..300).contains(&status) {
            let error_msg = format!("supabase {table} {method} failed: {status} {raw}")
                .trim()
                .to_string();
            self.backoff
                .lock()
                .unwrap()
                .mark_unavailable(&error_msg, now_ms);
            return Err(error_msg);
        }

        Ok(raw)
    }

    /// PostgREST GET helper.
    pub fn select(
        &self,
        table: &str,
        query: &[(&str, &str)],
        now_ms: u64,
    ) -> Result<Vec<Value>, String> {
        let options = RequestOptions {
            query: query
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            ..Default::default()
        };
        let body = self.request(table, "GET", None, &options, now_ms)?;
        if body.trim().is_empty() {
            return Ok(Vec::new());
        }
        serde_json::from_str::<Vec<Value>>(&body)
            .map_err(|e| format!("failed to parse select JSON: {e} (body: {body})"))
    }
}
