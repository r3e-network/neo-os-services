//! Automation supervisor: periodic and price-triggered automation job processing.
//!
//! Pinned against `workers/morpheus-relayer/src/automation.js`.

use neo_os_core::js_value::JsObject;
use serde::{Deserialize, Serialize};

use crate::config::RelayerConfig;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutomationResult {
    pub skipped: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub inspected: usize,
    pub queued: usize,
    pub failed: usize,
}

pub fn process_automation_jobs(config: &RelayerConfig, _state: &mut JsObject) -> AutomationResult {
    if config.mode == "feed_only" {
        return AutomationResult {
            skipped: true,
            reason: Some("mode is feed_only".to_string()),
            inspected: 0,
            queued: 0,
            failed: 0,
        };
    }

    let supabase_cfg = config.raw.get("supabase").and_then(|v| v.as_object());
    match supabase_cfg {
        Some(map) => {
            let url = map.get("url").and_then(|v| v.as_str()).unwrap_or("").trim();
            let key = map
                .get("serviceRoleKey")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            if url.is_empty() || key.is_empty() {
                return AutomationResult {
                    skipped: true,
                    reason: Some("supabase not configured".to_string()),
                    inspected: 0,
                    queued: 0,
                    failed: 0,
                };
            }
        }
        None => {
            return AutomationResult {
                skipped: true,
                reason: Some("supabase not configured".to_string()),
                inspected: 0,
                queued: 0,
                failed: 0,
            };
        }
    }

    // Claiming a row and recording a queued run is not execution. Until the Rust
    // runner can perform the job and persist its real outcome, fail closed and
    // leave every Supabase row untouched.
    AutomationResult {
        skipped: true,
        reason: Some("rust_automation_execution_not_implemented".to_string()),
        inspected: 0,
        queued: 0,
        failed: 0,
    }
}

#[cfg(test)]
mod tests {
    use neo_os_core::state::create_empty_relayer_state;
    use serde_json::json;

    use super::process_automation_jobs;
    use crate::config::RelayerConfig;

    #[test]
    fn configured_automation_lane_does_not_claim_or_fake_queueing() {
        let config = RelayerConfig {
            repo_root: ".".into(),
            instance_id: "test".into(),
            state_file: "unused.json".into(),
            network: "testnet".into(),
            node_env: "test".into(),
            mode: "combined".into(),
            active_chains: vec!["neo_n3".into()],
            poll_interval_ms: 1_000,
            concurrency: 1,
            max_blocks_per_tick: 10,
            discovery_idle_backoff_ms: 0,
            state_persist_min_interval_ms: 0,
            raw: json!({
                "supabase": {
                    "url": "https://example.invalid",
                    "serviceRoleKey": "test-only"
                }
            }),
        };
        let mut state = create_empty_relayer_state();

        let result = process_automation_jobs(&config, &mut state);

        assert!(result.skipped);
        assert_eq!(
            result.reason.as_deref(),
            Some("rust_automation_execution_not_implemented")
        );
        assert_eq!(result.queued, 0);
    }
}
