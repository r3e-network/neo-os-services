//! Operations across the 6 Supabase PostgREST tables (T03).
//!
//! Ported directly from `workers/morpheus-relayer/src/persistence.js:236-748`.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::supabase::{RequestOptions, SupabaseClient};
use crate::HttpTransport;

pub const QUARANTINE_PATCH_CHUNK_SIZE: usize = 40;
pub const AUTOMATION_PROCESSING_CLAIM_MARKER: &str = "__morpheus_automation_processing_claim__";

pub const RELAYER_JOB_FULL_SELECT: &str =
    "id,network,event_key,chain,request_id,request_type,tx_hash,block_number,route,status,attempts,last_error,next_retry_at,worker_status,worker_response,fulfill_tx,event,updated_at,completed_at,created_at";

/// Quote a value for PostgREST `in.(...)` filters (escapes quotes and backslashes).
pub fn quote_postgrest_in_value(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

// -----------------------------------------------------------------------------
// Table 1: morpheus_relayer_jobs
// -----------------------------------------------------------------------------

pub fn upsert_relayer_job<T: HttpTransport>(
    client: &SupabaseClient<T>,
    record: &Value,
    now_ms: u64,
) -> Result<String, String> {
    let mut payload = record.clone();
    if payload.get("network").is_none() {
        payload["network"] = Value::String(client.config().network.clone());
    }
    let options = RequestOptions {
        on_conflict: Some("network,event_key".into()),
        ..Default::default()
    };
    client.request(
        "morpheus_relayer_jobs",
        "POST",
        Some(&payload),
        &options,
        now_ms,
    )
}

pub fn insert_relayer_job_if_absent<T: HttpTransport>(
    client: &SupabaseClient<T>,
    record: &Value,
    now_ms: u64,
) -> Result<String, String> {
    let mut payload = record.clone();
    if payload.get("network").is_none() {
        payload["network"] = Value::String(client.config().network.clone());
    }
    let options = RequestOptions {
        on_conflict: Some("network,event_key".into()),
        ignore_duplicates: true,
        ..Default::default()
    };
    client.request(
        "morpheus_relayer_jobs",
        "POST",
        Some(&payload),
        &options,
        now_ms,
    )
}

pub fn patch_relayer_job<T: HttpTransport>(
    client: &SupabaseClient<T>,
    event_key: &str,
    fields: &Value,
    now_ms: u64,
) -> Result<String, String> {
    let network = &client.config().network;
    let options = RequestOptions {
        query: vec![
            ("event_key".into(), format!("eq.{event_key}")),
            ("network".into(), format!("eq.{network}")),
        ],
        ..Default::default()
    };
    client.request(
        "morpheus_relayer_jobs",
        "PATCH",
        Some(fields),
        &options,
        now_ms,
    )
}

/// Optimistic concurrency claim on `morpheus_relayer_jobs`.
///
/// Uses `or=(...)` across ready statuses and stale updated_at thresholds,
/// asking for `return=representation`.
/// Returns `Some(job)` on success (granted), or `None` on conflict.
pub fn claim_relayer_job<T: HttpTransport>(
    client: &SupabaseClient<T>,
    event_key: &str,
    fields: &Value,
    ready_statuses: &[&str],
    stale_statuses: &[&str],
    stale_before_iso: &str,
    now_ms: u64,
) -> Result<Option<Value>, String> {
    let network = &client.config().network;
    let mut or_parts = Vec::new();
    if !ready_statuses.is_empty() {
        or_parts.push(format!("status.in.({})", ready_statuses.join(",")));
    }
    if !stale_statuses.is_empty() && !stale_before_iso.trim().is_empty() {
        for status in stale_statuses {
            or_parts.push(format!(
                "and(status.eq.{status},updated_at.lt.{stale_before_iso})"
            ));
        }
    }

    let mut query = vec![
        ("event_key".into(), format!("eq.{event_key}")),
        ("network".into(), format!("eq.{network}")),
    ];
    if !or_parts.is_empty() {
        query.push(("or".into(), format!("({})", or_parts.join(","))));
    }

    let options = RequestOptions {
        query,
        return_representation: true,
        ..Default::default()
    };

    let raw = client.request(
        "morpheus_relayer_jobs",
        "PATCH",
        Some(fields),
        &options,
        now_ms,
    )?;
    if raw.trim().is_empty() {
        return Ok(None);
    }
    let rows: Vec<Value> = serde_json::from_str(&raw).unwrap_or_default();
    Ok(rows.into_iter().next())
}

pub fn fetch_relayer_jobs_by_statuses<T: HttpTransport>(
    client: &SupabaseClient<T>,
    statuses: &[&str],
    chain: Option<&str>,
    limit: usize,
    select: Option<&str>,
    now_ms: u64,
) -> Result<Vec<Value>, String> {
    if statuses.is_empty() {
        return Ok(Vec::new());
    }
    let network = &client.config().network;
    let status_filter = format!("in.({})", statuses.join(","));
    let limit_str = limit.to_string();
    let mut query_params: Vec<(String, String)> = vec![
        (
            "select".into(),
            select.unwrap_or(RELAYER_JOB_FULL_SELECT).to_string(),
        ),
        ("network".into(), format!("eq.{network}")),
        ("status".into(), status_filter),
        ("order".into(), "updated_at.asc".into()),
        ("limit".into(), limit_str),
    ];
    if let Some(ch) = chain {
        query_params.push(("chain".into(), format!("eq.{ch}")));
    }
    let slice: Vec<(&str, &str)> = query_params
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    client.select("morpheus_relayer_jobs", &slice, now_ms)
}

/// Quarantine relayer jobs below a numerical request_id floor.
pub fn quarantine_relayer_jobs_below_request_id<T: HttpTransport>(
    client: &SupabaseClient<T>,
    chain: &str,
    lt_request_id: u64,
    statuses: &[&str],
    note: &str,
    now_iso: &str,
    now_ms: u64,
) -> Result<usize, String> {
    let rows = fetch_relayer_jobs_by_statuses(
        client,
        statuses,
        Some(chain),
        5000,
        Some("event_key,request_id,last_error"),
        now_ms,
    )?;

    // Client-side numerical comparison because request_id is a text column in Postgres
    let mut target_rows = Vec::new();
    for row in rows {
        let req_id_num: u64 = row
            .get("request_id")
            .and_then(Value::as_str)
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        if req_id_num < lt_request_id {
            target_rows.push(row);
        }
    }

    if target_rows.is_empty() {
        return Ok(0);
    }

    // Group target rows by the updated last_error
    let mut groups: std::collections::BTreeMap<String, Vec<String>> =
        std::collections::BTreeMap::new();
    for row in target_rows {
        let prev_err = row
            .get("last_error")
            .and_then(Value::as_str)
            .unwrap_or("legacy open relayer job");
        let prefix = if !note.is_empty() {
            note.to_string()
        } else {
            format!("quarantined below request cursor floor {lt_request_id}")
        };
        let last_error = format!("{prefix} :: {prev_err}");
        let event_key = row
            .get("event_key")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        groups.entry(last_error).or_default().push(event_key);
    }

    let network = &client.config().network;
    let mut total_patched = 0;

    for (last_error, keys) in groups {
        for chunk in keys.chunks(QUARANTINE_PATCH_CHUNK_SIZE) {
            let quoted_keys = chunk
                .iter()
                .map(|k| quote_postgrest_in_value(k))
                .collect::<Vec<_>>()
                .join(",");
            let options = RequestOptions {
                query: vec![
                    ("event_key".into(), format!("in.({quoted_keys})")),
                    ("network".into(), format!("eq.{network}")),
                ],
                ..Default::default()
            };
            let patch_body = json!({
                "status": "stale_quarantined",
                "next_retry_at": Value::Null,
                "completed_at": now_iso,
                "updated_at": now_iso,
                "last_error": last_error,
            });
            client.request(
                "morpheus_relayer_jobs",
                "PATCH",
                Some(&patch_body),
                &options,
                now_ms,
            )?;
            total_patched += chunk.len();
        }
    }

    Ok(total_patched)
}

// -----------------------------------------------------------------------------
// Table 2: morpheus_relayer_runs
// -----------------------------------------------------------------------------

pub fn persist_relayer_run<T: HttpTransport>(
    client: &SupabaseClient<T>,
    payload: &Value,
    now_ms: u64,
) -> Result<String, String> {
    let mut data = payload.clone();
    if data.get("network").is_none() {
        data["network"] = Value::String(client.config().network.clone());
    }
    client.request(
        "morpheus_relayer_runs",
        "POST",
        Some(&data),
        &RequestOptions::default(),
        now_ms,
    )
}

// -----------------------------------------------------------------------------
// Table 3: morpheus_automation_jobs
// -----------------------------------------------------------------------------

pub fn upsert_automation_job<T: HttpTransport>(
    client: &SupabaseClient<T>,
    record: &Value,
    now_ms: u64,
) -> Result<String, String> {
    let mut payload = record.clone();
    if payload.get("network").is_none() {
        payload["network"] = Value::String(client.config().network.clone());
    }
    let options = RequestOptions {
        on_conflict: Some("network,automation_id".into()),
        ..Default::default()
    };
    client.request(
        "morpheus_automation_jobs",
        "POST",
        Some(&payload),
        &options,
        now_ms,
    )
}

pub fn patch_automation_job<T: HttpTransport>(
    client: &SupabaseClient<T>,
    automation_id: &str,
    fields: &Value,
    now_ms: u64,
) -> Result<String, String> {
    let network = &client.config().network;
    let options = RequestOptions {
        query: vec![
            ("automation_id".into(), format!("eq.{automation_id}")),
            ("network".into(), format!("eq.{network}")),
        ],
        ..Default::default()
    };
    client.request(
        "morpheus_automation_jobs",
        "PATCH",
        Some(fields),
        &options,
        now_ms,
    )
}

pub fn claim_automation_job<T: HttpTransport>(
    client: &SupabaseClient<T>,
    automation_id: &str,
    fields: &Value,
    due_at_iso: Option<&str>,
    stale_before_iso: Option<&str>,
    now_ms: u64,
) -> Result<Option<Value>, String> {
    let network = &client.config().network;
    let mut parts = Vec::new();
    if let Some(due) = due_at_iso.filter(|s| !s.trim().is_empty()) {
        parts.push("and(status.eq.active,next_run_at.is.null)".to_string());
        parts.push(format!("and(status.eq.active,next_run_at.lte.{due})"));
    } else {
        parts.push("status.eq.active".to_string());
    }
    if let Some(stale) = stale_before_iso.filter(|s| !s.trim().is_empty()) {
        parts.push(format!("and(status.eq.processing,updated_at.lt.{stale})"));
        parts.push(format!(
            "and(status.eq.paused,last_error.eq.{AUTOMATION_PROCESSING_CLAIM_MARKER},updated_at.lt.{stale})"
        ));
    }

    let mut query = vec![
        ("automation_id".into(), format!("eq.{automation_id}")),
        ("network".into(), format!("eq.{network}")),
    ];
    if !parts.is_empty() {
        query.push(("or".into(), format!("({})", parts.join(","))));
    }

    let options = RequestOptions {
        query,
        return_representation: true,
        ..Default::default()
    };

    match client.request(
        "morpheus_automation_jobs",
        "PATCH",
        Some(fields),
        &options,
        now_ms,
    ) {
        Ok(raw) => {
            let rows: Vec<Value> = serde_json::from_str(&raw).unwrap_or_default();
            Ok(rows.into_iter().next())
        }
        Err(err) => {
            if err.contains("morpheus_automation_jobs_status_check")
                || err.contains("violates check constraint")
            {
                // Fallback claim as paused with claim marker
                let mut fallback_fields = fields.clone();
                fallback_fields["status"] = Value::String("paused".into());
                fallback_fields["last_error"] =
                    Value::String(AUTOMATION_PROCESSING_CLAIM_MARKER.into());
                let raw = client.request(
                    "morpheus_automation_jobs",
                    "PATCH",
                    Some(&fallback_fields),
                    &options,
                    now_ms,
                )?;
                let rows: Vec<Value> = serde_json::from_str(&raw).unwrap_or_default();
                Ok(rows.into_iter().next())
            } else {
                Err(err)
            }
        }
    }
}

pub fn fetch_automation_job_by_id<T: HttpTransport>(
    client: &SupabaseClient<T>,
    automation_id: &str,
    now_ms: u64,
) -> Result<Option<Value>, String> {
    let network = &client.config().network;
    let query = [
        ("select", "*"),
        ("network", network.as_str()),
        ("automation_id", &format!("eq.{automation_id}")),
        ("limit", "1"),
    ];
    let rows = client.select("morpheus_automation_jobs", &query, now_ms)?;
    Ok(rows.into_iter().next())
}

pub fn count_active_automations_by_requester<T: HttpTransport>(
    client: &SupabaseClient<T>,
    requester: &str,
    max_count: usize,
    now_ms: u64,
) -> Result<usize, String> {
    let network = &client.config().network;
    let limit_str = max_count.to_string();
    let query = [
        ("select", "automation_id"),
        ("network", network.as_str()),
        ("requester", &format!("eq.{requester}")),
        ("status", "eq.active"),
        ("limit", limit_str.as_str()),
    ];
    let rows = client.select("morpheus_automation_jobs", &query, now_ms)?;
    Ok(rows.len())
}

// -----------------------------------------------------------------------------
// Table 4: morpheus_automation_runs
// -----------------------------------------------------------------------------

pub fn insert_automation_run<T: HttpTransport>(
    client: &SupabaseClient<T>,
    record: &Value,
    now_ms: u64,
) -> Result<String, String> {
    let mut payload = record.clone();
    if payload.get("network").is_none() {
        payload["network"] = Value::String(client.config().network.clone());
    }
    client.request(
        "morpheus_automation_runs",
        "POST",
        Some(&payload),
        &RequestOptions::default(),
        now_ms,
    )
}

pub fn patch_automation_run_by_queue_tx_hash<T: HttpTransport>(
    client: &SupabaseClient<T>,
    tx_hash: &str,
    fields: &Value,
    now_ms: u64,
) -> Result<String, String> {
    let network = &client.config().network;
    let options = RequestOptions {
        query: vec![
            ("network".into(), format!("eq.{network}")),
            ("queue_tx->>tx_hash".into(), format!("eq.{tx_hash}")),
        ],
        ..Default::default()
    };
    client.request(
        "morpheus_automation_runs",
        "PATCH",
        Some(fields),
        &options,
        now_ms,
    )
}

// -----------------------------------------------------------------------------
// Table 5: morpheus_encrypted_secrets
// -----------------------------------------------------------------------------

pub fn persist_automation_encrypted_fields<T: HttpTransport>(
    client: &SupabaseClient<T>,
    job: &Value,
    now_ms: u64,
) -> Result<(), String> {
    let payload = job.get("execution_payload").unwrap_or(&Value::Null);
    let mut encrypted_entries = Vec::new();
    collect_encrypted_fields(payload, &mut Vec::new(), &mut encrypted_entries);
    if encrypted_entries.is_empty() {
        return Ok(());
    }

    let automation_id = job
        .get("automation_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let network = job
        .get("network")
        .and_then(Value::as_str)
        .unwrap_or(&client.config().network);
    let chain = job.get("chain").and_then(Value::as_str).unwrap_or_default();
    let reg_req_id = job
        .get("registration_request_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let project_id = job.get("project_id").cloned().unwrap_or(Value::Null);

    let mut rows = Vec::new();
    for (field_path, ciphertext) in encrypted_entries {
        let mut hasher = Sha256::new();
        hasher.update(ciphertext.as_bytes());
        let digest_hex = hex::encode(hasher.finalize());

        rows.push(json!({
            "project_id": project_id,
            "network": network,
            "name": format!("automation:{automation_id}:{field_path}"),
            "target_chain": chain,
            "encryption_algorithm": "client-supplied-ciphertext",
            "key_version": 1,
            "ciphertext": ciphertext,
            "metadata": {
                "automation_id": automation_id,
                "network": network,
                "registration_request_id": reg_req_id,
                "field_path": field_path,
                "ciphertext_sha256": digest_hex,
            }
        }));
    }

    client.request(
        "morpheus_encrypted_secrets",
        "POST",
        Some(&Value::Array(rows)),
        &RequestOptions::default(),
        now_ms,
    )?;
    Ok(())
}

fn collect_encrypted_fields(
    value: &Value,
    path: &mut Vec<String>,
    results: &mut Vec<(String, String)>,
) {
    match value {
        Value::Object(map) => {
            for (key, current) in map {
                path.push(key.clone());
                if key.starts_with("encrypted_") {
                    if let Some(ct) = current.as_str() {
                        if !ct.trim().is_empty() {
                            results.push((path.join("."), ct.trim().to_string()));
                            path.pop();
                            continue;
                        }
                    }
                }
                if key == "encrypted_inputs" {
                    if let Value::Object(nested) = current {
                        for (nested_k, nested_v) in nested {
                            if let Some(ct) = nested_v.as_str() {
                                if !ct.trim().is_empty() {
                                    let mut p = path.clone();
                                    p.push(nested_k.clone());
                                    results.push((p.join("."), ct.trim().to_string()));
                                }
                            }
                        }
                        path.pop();
                        continue;
                    }
                }
                collect_encrypted_fields(current, path, results);
                path.pop();
            }
        }
        Value::Array(arr) => {
            for (i, current) in arr.iter().enumerate() {
                path.push(i.to_string());
                collect_encrypted_fields(current, path, results);
                path.pop();
            }
        }
        _ => {}
    }
}

// -----------------------------------------------------------------------------
// Table 6: morpheus_feed_snapshots
// -----------------------------------------------------------------------------

pub fn persist_feed_snapshot<T: HttpTransport>(
    client: &SupabaseClient<T>,
    record: &Value,
    now_ms: u64,
) -> Result<String, String> {
    let mut payload = record.clone();
    if payload.get("network").is_none() {
        payload["network"] = Value::String(client.config().network.clone());
    }
    let options = RequestOptions {
        on_conflict: Some("network,feed_id".into()),
        ..Default::default()
    };
    client.request(
        "morpheus_feed_snapshots",
        "POST",
        Some(&payload),
        &options,
        now_ms,
    )
}
