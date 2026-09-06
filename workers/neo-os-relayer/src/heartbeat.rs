//! Betterstack heartbeat reporting.
//!
//! Pinned against `workers/morpheus-relayer/src/heartbeat.js`.

use serde::Serialize;
use std::time::Duration;

fn resolve_timeout_ms() -> u64 {
    let configured = std::env::var("MORPHEUS_HEARTBEAT_TIMEOUT_MS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok());
    match configured {
        Some(v) => std::cmp::max(250, v),
        None => 3000,
    }
}

pub async fn send_heartbeat<T: Serialize>(url: &str, payload: Option<&T>) -> bool {
    let target = url.trim();
    if target.is_empty() {
        return false;
    }

    let timeout = Duration::from_millis(resolve_timeout_ms());
    let client = match reqwest::Client::builder().timeout(timeout).build() {
        Ok(c) => c,
        Err(_) => return false,
    };

    let req = if let Some(p) = payload {
        client
            .post(target)
            .header("content-type", "application/json")
            .json(p)
    } else {
        client.get(target)
    };

    req.send().await.is_ok()
}
