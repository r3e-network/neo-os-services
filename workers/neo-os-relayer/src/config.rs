//! Relayer configuration loading and schema mapping.
//!
//! Wraps `neo_os_core::config::derive_pure_fields` and adds IO-bound paths:
//! state file location and process instance id. Network registries are embedded.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use neo_os_core::config::{
    configured_host_signer_env_names, default_state_file_name, derive_pure_fields_with_rpc_urls,
    EnvSource,
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

    pub fn is_production(&self) -> bool {
        self.node_env.eq_ignore_ascii_case("production")
    }

    pub fn automation_enabled(&self) -> bool {
        self.raw
            .pointer("/automation/enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }

    pub fn allows_unavailable_automation(&self) -> bool {
        self.raw
            .pointer("/automation/allowUnavailable")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }

    /// Refuse lanes whose complete commit protocol is unavailable.
    /// Production always rejects `automation.enabled`. Non-production may
    /// start only with an explicit `automation.allowUnavailable` /
    /// `MORPHEUS_ALLOW_UNAVAILABLE_AUTOMATION=true` opt-in; the lane itself
    /// still reports `rust_automation_execution_not_implemented`.
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
        if self.automation_enabled()
            && (self.is_production() || !self.allows_unavailable_automation())
        {
            return Err(Self::AUTOMATION_DELIVERY_UNAVAILABLE.to_string());
        }
        if self.is_production() && !crate::durable_v2::enabled(self) {
            return Err("production request delivery requires MORPHEUS_DELIVERY_PROTOCOL=v2 and the durable migration/cutover".into());
        }
        if crate::durable_v2::enabled(self)
            && (self.active_chains.is_empty()
                || self
                    .active_chains
                    .iter()
                    .any(|chain| !matches!(chain.as_str(), "neo_n3" | "neox")))
        {
            return Err(
                "durable v2 requires at least one supported active chain (neo_n3 or neox)".into(),
            );
        }
        if !crate::durable_v2::enabled(self)
            && !self.is_production()
            && self.node_env != "test"
            && !self
                .raw
                .get("allowLegacyLocal")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        {
            return Err("legacy local delivery requires MORPHEUS_ALLOW_LEGACY_LOCAL=true outside production".into());
        }
        Ok(())
    }
}

pub fn load_network_registry(network: &str) -> JsValue {
    neo_os_core::network_identity::known_network_registry(network)
        .map(JsValue::from_json)
        .unwrap_or(JsValue::Undefined)
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
    let runtime_config = crate::config_introspect::parse_runtime_config(env)?;

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
    let network =
        neo_os_core::network_identity::resolve_reviewed_network(if raw_network.is_empty() {
            None
        } else {
            Some(raw_network.as_str())
        })
        .map_err(|error| error.to_string())?;

    let registry = load_network_registry(&network);

    let local_chain = env_source.env(&["MORPHEUS_LOCAL_CHAIN"]) == "true";
    let local_urls = if local_chain {
        validate_local_source(&env_source, &network)?;
        let urls = neo_os_core::config::parse_url_list(&JsValue::Str(
            env_source.env(&["MORPHEUS_LOCAL_CHAIN_RPC_URLS"]),
        ));
        if urls.is_empty() {
            return Err("local-chain requires explicit loopback RPC URLs".into());
        }
        Some(urls)
    } else {
        None
    };
    let pure_fields = derive_pure_fields_with_rpc_urls(&env_source, &registry, "", local_urls)
        .map_err(|e| e.0)?;

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
        let hostname = env.get("HOSTNAME").cloned().unwrap_or_else(|| "localhost".to_string());
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
    if local_chain {
        validate_local_fields(&raw_val)?;
        raw_val["localChain"] = Value::Bool(true);
        raw_val["neo_n3"]["networkMagic"] = Value::from(894710606u32);
    }
    if let Value::Object(ref mut map) = raw_val {
        // Snapshot the caller's explicit environment once. Library consumers
        // must not resolve another network's process-global credentials later.
        map.insert("storeAuth".into(), serde_json::json!({
            "mode":"legacy_admin",
            "url":env.get("SUPABASE_URL").or_else(||env.get("morpheus_SUPABASE_URL")).cloned().unwrap_or_default(),
            "apiKey":env.get("SUPABASE_SERVICE_ROLE_KEY").or_else(||env.get("morpheus_SUPABASE_SERVICE_ROLE_KEY")).cloned().unwrap_or_default()
        }));
        map.insert(
            "deliveryProtocol".into(),
            Value::String(env_source.env(&["MORPHEUS_DELIVERY_PROTOCOL"])),
        );
        map.insert(
            "allowLegacyLocal".into(),
            Value::Bool(
                env_source
                    .env(&["MORPHEUS_ALLOW_LEGACY_LOCAL"])
                    .eq_ignore_ascii_case("true"),
            ),
        );
        map.insert(
            "repoRoot".to_string(),
            Value::String(repo_root.to_string_lossy().to_string()),
        );
        map.insert("instanceId".to_string(), Value::String(instance_id.clone()));
        let archives = env_source.env(&["MORPHEUS_N3_RECONCILIATION_ARCHIVE_RPC_URLS"]);
        if !archives.trim().is_empty() {
            if let Some(n3) = map.get_mut("neo_n3").and_then(Value::as_object_mut) {
                n3.insert(
                    "reconciliationArchiveRpcUrls".into(),
                    serde_json::json!(archives
                        .split(',')
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .collect::<Vec<_>>()),
                );
            }
        }
        map.insert(
            "stateFile".to_string(),
            Value::String(state_file.to_string_lossy().to_string()),
        );
        let allow_unavailable = env_source
            .env(&["MORPHEUS_ALLOW_UNAVAILABLE_AUTOMATION"])
            .eq_ignore_ascii_case("true");
        match map.get_mut("automation") {
            Some(Value::Object(automation)) => {
                automation.insert(
                    "allowUnavailable".to_string(),
                    Value::Bool(allow_unavailable),
                );
            }
            _ => {
                map.insert(
                    "automation".to_string(),
                    serde_json::json!({ "allowUnavailable": allow_unavailable }),
                );
            }
        }
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

fn validate_local_source(source: &EnvSource, network: &str) -> Result<(), String> {
    if network != "testnet" {
        return Err("local-chain requires the testnet profile".into());
    }
    neo_os_chain_n3::rpc::validate_local_chain_context(&source.env(&["NODE_ENV"]), 894710606)?;
    // Check both sources, including aliases hidden by precedence, before deriving
    // the effective endpoints. A configured remote host must never be ignored.
    // Resolve each source independently so packed arrays use the same string
    // coercion as effective configuration without hiding lower-priority values.
    for isolated in [
        EnvSource::new(source.process_env.clone(), JsObject::new()),
        EnvSource::new(JsObject::new(), source.runtime_config.clone()),
    ] {
        for (name, _) in isolated
            .process_env
            .iter()
            .chain(isolated.runtime_config.iter())
        {
            let value = isolated.env(&[name]);
            if name == "NODE_ENV" && value.eq_ignore_ascii_case("production") {
                return Err("local-chain is refused in production".into());
            }
            let relevant = [
                "MORPHEUS_",
                "NITRO_",
                "NEO_",
                "NEOX_",
                "SIGNER_",
                "SUPABASE_",
                "NEXT_PUBLIC_",
                "MAINNET_",
                "TESTNET_",
                "morpheus_",
            ]
            .iter()
            .any(|p| name.starts_with(p));
            // resolve_neo_n3_rpc_urls and the NeoX resolver also accept these
            // aliases, which do not follow the ordinary URL/URLS suffix rule.
            let rpc_alias = matches!(
                name,
                "NEO_RPC_URLS_MAINNET"
                    | "NEO_RPC_URLS_TESTNET"
                    | "NEO_RPC_MAINNET"
                    | "NEO_RPC_TESTNET"
                    | "NEOX_RPC"
            );
            if rpc_alias || (relevant && (name.ends_with("_URL") || name.ends_with("_URLS"))) {
                for url in neo_os_core::config::parse_url_list(&JsValue::Str(value)) {
                    neo_os_chain_n3::rpc::validate_local_chain_url(&url)?;
                }
            }
        }
    }
    Ok(())
}

fn validate_local_fields(raw: &Value) -> Result<(), String> {
    if raw["mode"] != "requests_only"
        || raw["activeChains"] != serde_json::json!(["neo_n3"])
        || raw["neo_n3"]["scanMode"] != "block_cursor"
        || raw["nitro"]["allowFallback"] != false
    {
        return Err("local-chain requires requests_only, neo_n3, block_cursor and disabled runtime fallbacks".into());
    }
    let magic = if raw["neo_n3"]["networkMagic"].as_f64() == Some(894710606.0) {
        894710606
    } else {
        0
    };
    neo_os_chain_n3::rpc::validate_local_chain_context(
        raw["nodeEnv"].as_str().unwrap_or(""),
        magic,
    )?;
    let urls = raw["neo_n3"]["rpcUrls"]
        .as_array()
        .filter(|urls| !urls.is_empty())
        .ok_or("local-chain requires a nonempty resolved RPC URL list")?;
    for url in urls {
        let url = url.as_str().ok_or("local-chain requires string RPC URLs")?;
        neo_os_chain_n3::rpc::validate_local_chain_url(url)?;
    }
    if let Some(heartbeats) = raw["heartbeats"].as_object() {
        for value in heartbeats
            .values()
            .filter_map(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            neo_os_chain_n3::rpc::validate_local_chain_url(value)?;
        }
    }
    for field in [
        "apiUrl",
        "signerUrl",
        "custodyUrl",
        "enclaveFulfillUrl",
        "decryptUrl",
    ] {
        if let Some(urls) = raw["nitro"][field].as_str() {
            for url in urls.split(',').filter(|s| !s.is_empty()) {
                neo_os_chain_n3::rpc::validate_local_chain_url(url)?;
            }
        }
    }
    Ok(())
}

/// One selection point for scanning, delivery and transaction reconciliation.
pub(crate) fn n3_rpc<T: neo_os_chain_n3::HttpTransport>(
    config: &RelayerConfig,
    transport: T,
    urls: Vec<String>,
    enforce_ssrf: bool,
) -> Result<neo_os_chain_n3::rpc::NeoRpcClient<T>, String> {
    if config.raw.get("localChain").and_then(Value::as_bool) == Some(true) {
        validate_local_fields(&config.raw)?;
        if config.network != "testnet" || config.is_production() {
            return Err("local-chain requires non-production testnet".into());
        }
        neo_os_chain_n3::rpc::NeoRpcClient::new_local(transport, urls, &config.node_env, 894710606)
    } else {
        neo_os_chain_n3::rpc::NeoRpcClient::new(transport, urls, enforce_ssrf)
    }
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
    #[test]
    fn local_fields_refuse_invalid_resolved_rpc_lists() {
        let valid = serde_json::json!({
            "mode": "requests_only", "activeChains": ["neo_n3"],
            "nodeEnv": "test", "nitro": {"allowFallback": false},
            "neo_n3": {"scanMode": "block_cursor", "networkMagic": 894710606,
                "rpcUrls": ["http://127.0.0.1:23456"]}
        });
        assert!(super::validate_local_fields(&valid).is_ok());
        for urls in [
            serde_json::json!(["https://remote.example"]),
            serde_json::json!(["http://127.0.0.1:23456", "https://remote.example"]),
            serde_json::json!([]),
            serde_json::json!([null]),
            serde_json::json!([42]),
            serde_json::json!("http://127.0.0.1:23456"),
            serde_json::Value::Null,
        ] {
            let mut raw = valid.clone();
            raw["neo_n3"]["rpcUrls"] = urls.clone();
            assert!(
                super::validate_local_fields(&raw).is_err(),
                "accepted {urls}"
            );
        }
    }
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
    fn production_rejects_unavailable_automation_at_startup() {
        for mode in ["combined", "requests_only"] {
            let mut ready = config(mode);
            ready.active_chains = vec!["neo_n3".into(), "neox".into()];
            ready
                .ensure_runtime_ready()
                .expect("both chains have complete custody-to-confirmation pipelines");
        }

        let mut production = config("requests_only");
        production.node_env = "production".into();
        production.raw = serde_json::json!({
            "automation": { "enabled": true, "allowUnavailable": true }
        });
        assert_eq!(
            production
                .ensure_runtime_ready()
                .expect_err("production cannot opt into unavailable automation"),
            RelayerConfig::AUTOMATION_DELIVERY_UNAVAILABLE
        );

        let mut development = config("requests_only");
        development.node_env = "development".into();
        development.raw = serde_json::json!({"automation": {"enabled": true}});
        assert_eq!(
            development
                .ensure_runtime_ready()
                .expect_err("development still requires an explicit allow"),
            RelayerConfig::AUTOMATION_DELIVERY_UNAVAILABLE
        );

        development.raw = serde_json::json!({
            "allowLegacyLocal": true,
            "automation": { "enabled": true, "allowUnavailable": true }
        });
        development
            .ensure_runtime_ready()
            .expect("development may explicitly allow the unavailable lane");

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

    #[test]
    fn rust_wrapper_refuses_a_corrupt_or_non_object_runtime_config() {
        // Truncated JSON that names mainnet: read as empty, it would start the
        // relayer on its TestNet defaults.
        let secret = "packed-secret-value-0123456789";
        let corrupt = format!(
            r#"{{"MORPHEUS_NETWORK":"mainnet","MORPHEUS_RELAYER_ADMIN_API_KEY":"{secret}""#
        );
        let env = BTreeMap::from([("MORPHEUS_RUNTIME_CONFIG_JSON".to_string(), corrupt)]);
        let error = create_relayer_config_from_env(&env)
            .expect_err("a corrupt runtime config must not start on defaults");
        assert!(
            error.contains("MORPHEUS_RUNTIME_CONFIG_JSON is not valid JSON"),
            "{error}"
        );
        assert!(!error.contains(secret), "the error must not echo the value");
        for value in [r#"["mainnet"]"#, r#""mainnet""#, "42", "null"] {
            let env = BTreeMap::from([(
                "MORPHEUS_RUNTIME_CONFIG_JSON".to_string(),
                value.to_string(),
            )]);
            let error = create_relayer_config_from_env(&env).expect_err(value);
            assert!(
                error.contains("MORPHEUS_RUNTIME_CONFIG_JSON must be a JSON object"),
                "{value}: {error}"
            );
        }
    }

    #[test]
    fn rust_wrapper_treats_a_packed_false_or_zero_network_as_explicit() {
        for packed in ["false", "0"] {
            let env = BTreeMap::from([(
                "MORPHEUS_RUNTIME_CONFIG_JSON".to_string(),
                format!(r#"{{"MORPHEUS_NETWORK":{packed}}}"#),
            )]);
            let error = create_relayer_config_from_env(&env)
                .expect_err("a packed non-string network must not read as absent");
            assert!(
                error.contains("unsupported Neo network"),
                "{packed}: {error}"
            );
        }
    }

    #[test]
    fn rust_wrapper_rejects_unknown_network_before_registry_selection() {
        let env = BTreeMap::from([("MORPHEUS_NETWORK".to_string(), "staging".to_string())]);
        let error = create_relayer_config_from_env(&env)
            .expect_err("an unknown network must not default to TestNet");
        assert!(error.contains("unsupported Neo network"));
    }
}
