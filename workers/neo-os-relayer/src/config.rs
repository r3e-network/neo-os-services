//! Relayer configuration loading and schema mapping.
//!
//! Wraps `neo_os_core::config::derive_pure_fields` and adds IO-bound paths:
//! state file location, network registry loading, and process instance id.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use neo_os_core::config::{
    configured_host_signer_env_names, default_state_file_name, derive_pure_fields,
    normalize_morpheus_network, EnvSource,
};
use neo_os_core::js_value::{JsObject, JsValue};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub fn js_value_to_json(val: &JsValue) -> Value {
    match val {
        JsValue::Undefined | JsValue::Null => Value::Null,
        JsValue::Bool(b) => Value::Bool(*b),
        JsValue::Number(n) => {
            if n.is_finite() {
                serde_json::Number::from_f64(*n)
                    .map(Value::Number)
                    .unwrap_or(Value::Null)
            } else {
                Value::Null
            }
        }
        JsValue::BigInt(s) => Value::String(s.clone()),
        JsValue::Str(s) => Value::String(s.clone()),
        JsValue::Array(items) => Value::Array(items.iter().map(js_value_to_json).collect()),
        JsValue::Object(obj) => {
            let mut map = serde_json::Map::new();
            for (k, v) in obj.iter() {
                map.insert(k.to_string(), js_value_to_json(v));
            }
            Value::Object(map)
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayerConfig {
    pub repo_root: String,
    pub instance_id: String,
    pub state_file: String,
    pub network: String,
    pub node_env: String,
    pub mode: String,
    pub active_chains: Vec<String>,
    pub poll_interval_ms: u64,
    pub concurrency: usize,
    pub max_blocks_per_tick: u64,
    pub discovery_idle_backoff_ms: u64,
    pub state_persist_min_interval_ms: u64,
    pub raw: Value,
}

impl RelayerConfig {
    pub const AUTOMATION_DELIVERY_UNAVAILABLE: &'static str =
        "Rust automation delivery is unavailable; disable MORPHEUS_AUTOMATION_ENABLED until durable claim, on-chain queue confirmation, and run persistence are enabled";
    pub const FEED_ONLY_REQUIRES_FEED_SYNC: &'static str =
        "feed_only mode requires MORPHEUS_FEED_SYNC_ENABLED=true; refusing to start an idle relayer";

    pub fn is_feed_only(&self) -> bool {
        self.mode == "feed_only"
    }

    pub fn is_requests_only(&self) -> bool {
        self.mode == "requests_only"
    }

    pub fn should_run_feed_sync(&self) -> bool {
        !self.is_requests_only()
    }

    pub fn should_run_request_processing(&self) -> bool {
        !self.is_feed_only()
    }

    /// Refuse only lanes whose complete commit protocol is unavailable.
    /// Automation is deliberately NOT a startup gate (review P2-16): enabling
    /// it must not take down the whole request/combined runtime. The automation
    /// lane itself is fail-closed — it reports
    /// `rust_automation_execution_not_implemented` in its own result and the
    /// control plane returns 503 — so the capability is unavailable without
    /// losing core request scanning.
    pub fn ensure_runtime_ready(&self) -> Result<(), String> {
        if self.is_feed_only()
            && !self
                .raw
                .pointer("/feedSync/enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        {
            return Err(Self::FEED_ONLY_REQUIRES_FEED_SYNC.to_string());
        }
        Ok(())
    }
}

pub fn load_network_registry(network: &str) -> JsValue {
    let candidates = [
        format!("config/networks/{network}.json"),
        format!("../../config/networks/{network}.json"),
        format!("../../../config/networks/{network}.json"),
    ];

    for candidate in &candidates {
        let p = Path::new(candidate);
        if p.exists() {
            if let Ok(content) = std::fs::read_to_string(p) {
                if let Ok(val) = serde_json::from_str::<Value>(&content) {
                    return JsValue::from_json(&val);
                }
            }
        }
    }

    JsValue::Undefined
}

pub fn resolve_repo_root() -> PathBuf {
    if let Ok(dir) = std::env::current_dir() {
        let mut cur = dir;
        loop {
            if cur.join("Cargo.toml").exists() && cur.join("crates").exists() {
                return cur;
            }
            if !cur.pop() {
                break;
            }
        }
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

pub fn create_relayer_config() -> Result<RelayerConfig, String> {
    let process_env: BTreeMap<String, String> = std::env::vars().collect();
    create_relayer_config_from_env(&process_env)
}

pub fn create_relayer_config_from_env(
    env: &BTreeMap<String, String>,
) -> Result<RelayerConfig, String> {
    let repo_root = resolve_repo_root();
    let runtime_config = crate::config_introspect::parse_runtime_config(env);

    let mut process_env_obj = JsObject::new();
    for (k, v) in env {
        process_env_obj.set(k.clone(), JsValue::Str(v.clone()));
    }

    let mut runtime_config_obj = JsObject::new();
    for (k, v) in &runtime_config {
        runtime_config_obj.set(k.clone(), JsValue::from_json(v));
    }

    let env_source = EnvSource::new(process_env_obj, runtime_config_obj);
    reject_host_evm_private_keys(&env_source)?;

    let raw_network = env_source.env(&["MORPHEUS_NETWORK", "NEXT_PUBLIC_MORPHEUS_NETWORK"]);
    let network = if raw_network.is_empty() {
        "testnet".to_string()
    } else {
        normalize_morpheus_network(&JsValue::Str(raw_network))
    };

    let registry = load_network_registry(&network);

    let pure_fields = derive_pure_fields(&env_source, &registry, "").map_err(|e| e.0)?;

    let mode = pure_fields
        .get("mode")
        .map(|v| match v {
            JsValue::Str(s) => s.clone(),
            _ => "combined".to_string(),
        })
        .unwrap_or_else(|| "combined".to_string());

    let state_file_override = env_source.env(&["MORPHEUS_RELAYER_STATE_FILE"]);
    let state_file = if !state_file_override.is_empty() {
        Path::new(&state_file_override).to_path_buf()
    } else {
        let name = default_state_file_name(&mode);
        repo_root.join(name)
    };

    let instance_id_override = env_source.env(&["MORPHEUS_RELAYER_INSTANCE_ID"]);
    let instance_id = if !instance_id_override.is_empty() {
        instance_id_override
    } else {
        let hostname = std::env::var("HOSTNAME").unwrap_or_else(|_| "localhost".to_string());
        let pid = std::process::id();
        format!("{hostname}:{pid}")
    };

    let node_env = pure_fields
        .get("nodeEnv")
        .map(|v| match v {
            JsValue::Str(s) => s.clone(),
            _ => "development".to_string(),
        })
        .unwrap_or_else(|| "development".to_string());

    let poll_interval_ms = pure_fields
        .get("pollIntervalMs")
        .and_then(|v| match v {
            JsValue::Number(n) => Some(*n as u64),
            _ => None,
        })
        .unwrap_or(5000);

    let concurrency = pure_fields
        .get("concurrency")
        .and_then(|v| match v {
            JsValue::Number(n) => Some(*n as usize),
            _ => None,
        })
        .unwrap_or(4);

    let max_blocks_per_tick = pure_fields
        .get("maxBlocksPerTick")
        .and_then(|v| match v {
            JsValue::Number(n) => Some(*n as u64),
            _ => None,
        })
        .unwrap_or(100);

    let discovery_idle_backoff_ms = pure_fields
        .get("discoveryIdleBackoffMs")
        .and_then(|v| match v {
            JsValue::Number(n) => Some(*n as u64),
            _ => None,
        })
        .unwrap_or(0);

    let state_persist_min_interval_ms = pure_fields
        .get("statePersistMinIntervalMs")
        .and_then(|v| match v {
            JsValue::Number(n) => Some(*n as u64),
            _ => None,
        })
        .unwrap_or(0);

    let active_chains = pure_fields
        .get("activeChains")
        .map(|v| match v {
            JsValue::Array(arr) => arr
                .iter()
                .filter_map(|item| match item {
                    JsValue::Str(s) => Some(s.clone()),
                    _ => None,
                })
                .collect(),
            _ => vec!["neo_n3".to_string()],
        })
        .unwrap_or_else(|| vec!["neo_n3".to_string()]);

    let mut raw_val = js_value_to_json(&JsValue::Object(pure_fields));
    if let Value::Object(ref mut map) = raw_val {
        map.insert(
            "repoRoot".to_string(),
            Value::String(repo_root.to_string_lossy().to_string()),
        );
        map.insert("instanceId".to_string(), Value::String(instance_id.clone()));
        map.insert(
            "stateFile".to_string(),
            Value::String(state_file.to_string_lossy().to_string()),
        );
    }

    Ok(RelayerConfig {
        repo_root: repo_root.to_string_lossy().to_string(),
        instance_id,
        state_file: state_file.to_string_lossy().to_string(),
        network,
        node_env,
        mode,
        active_chains,
        poll_interval_ms,
        concurrency,
        max_blocks_per_tick,
        discovery_idle_backoff_ms,
        state_persist_min_interval_ms,
        raw: raw_val,
    })
}

pub(crate) fn reject_host_evm_private_keys(source: &EnvSource) -> Result<(), String> {
    let mut names: Vec<String> = configured_host_signer_env_names(source)
        .into_iter()
        .filter(|name| {
            let normalized = name.to_ascii_lowercase();
            normalized.contains("neox") || normalized.contains("evm")
        })
        .collect();
    names.sort();
    if names.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "host NeoX/EVM private-key configuration is forbidden in the Rust relayer; use SIGNER_SERVICE_URL, SIGNER_SERVICE_TOKEN, and neox custody key ids instead (configured: {})",
            names.join(", ")
        ))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::{create_relayer_config_from_env, RelayerConfig};

    fn config(mode: &str) -> RelayerConfig {
        RelayerConfig {
            repo_root: ".".into(),
            instance_id: "test".into(),
            state_file: "unused.json".into(),
            network: "testnet".into(),
            node_env: "test".into(),
            mode: mode.into(),
            active_chains: vec!["neo_n3".into()],
            poll_interval_ms: 1_000,
            concurrency: 1,
            max_blocks_per_tick: 1,
            discovery_idle_backoff_ms: 0,
            state_persist_min_interval_ms: 0,
            raw: serde_json::json!({}),
        }
    }

    #[test]
    fn automation_does_not_gate_core_request_startup() {
        // Review P2-16: enabling automation must not take down the whole
        // request/combined runtime. The lane fails closed in its own result;
        // the core pipeline stays ready.
        for mode in ["combined", "requests_only"] {
            let mut ready = config(mode);
            ready.active_chains = vec!["neo_n3".into(), "neox".into()];
            ready
                .ensure_runtime_ready()
                .expect("both chains have complete custody-to-confirmation pipelines");
        }

        let mut automation = config("requests_only");
        automation.raw = serde_json::json!({"automation": {"enabled": true}});
        automation
            .ensure_runtime_ready()
            .expect("automation is a bounded capability, not a startup failure");

        let mut feed = config("feed_only");
        assert_eq!(
            feed.ensure_runtime_ready()
                .expect_err("idle feed mode closed"),
            RelayerConfig::FEED_ONLY_REQUIRES_FEED_SYNC
        );
        feed.raw = serde_json::json!({"feedSync": {"enabled": true}});
        feed.ensure_runtime_ready()
            .expect("enabled feed mode has an authoritative delivery lane");
    }

    #[test]
    fn rust_wrapper_rejects_host_evm_keys_even_with_legacy_development_opt_in() {
        for packed in [false, true] {
            let mut env = BTreeMap::from([
                ("NODE_ENV".to_string(), "development".to_string()),
                ("MORPHEUS_RELAYER_MODE".to_string(), "feed_only".to_string()),
                (
                    "MORPHEUS_ALLOW_INSECURE_HOST_EVM_SIGNER".to_string(),
                    "true".to_string(),
                ),
            ]);
            if packed {
                env.insert(
                    "MORPHEUS_RUNTIME_CONFIG_JSON".to_string(),
                    r#"{"MORPHEUS_RELAYER_NEOX_UPDATER_PK":"secret"}"#.to_string(),
                );
            } else {
                env.insert(
                    "MORPHEUS_RELAYER_NEOX_UPDATER_PK".to_string(),
                    "secret".to_string(),
                );
            }

            let error = create_relayer_config_from_env(&env)
                .expect_err("Rust wrapper must never accept host EVM key material");
            assert!(error.contains("forbidden in the Rust relayer"));
            assert!(!error.contains("secret"));
        }
    }
}
