//! Read-only introspection and validation over the relayer config schema.
//!
//! Pinned against `workers/morpheus-relayer/src/config-introspect.js`.

use std::collections::BTreeMap;

use neo_os_core::config_schema::{
    is_secret_env_name, known_env_aliases, ConfigSetting, CONFIG_SCHEMA, DIRECT_CONTROL_ENV_KEYS,
};
use neo_os_core::js_value::{JsObject, JsValue};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const REDACTED: &str = "«redacted»";

pub fn edit_distance(a: &str, b: &str) -> usize {
    let a_chars: Vec<char> = a.chars().collect();
    let b_chars: Vec<char> = b.chars().collect();
    let m = a_chars.len();
    let n = b_chars.len();

    if m == 0 {
        return n;
    }
    if n == 0 {
        return m;
    }

    let mut prev: Vec<usize> = (0..=n).collect();
    let mut curr: Vec<usize> = vec![0; n + 1];

    for i in 1..=m {
        curr[0] = i;
        for j in 1..=n {
            let cost = if a_chars[i - 1] == b_chars[j - 1] {
                0
            } else {
                1
            };
            curr[j] = std::cmp::min(
                std::cmp::min(curr[j - 1] + 1, prev[j] + 1),
                prev[j - 1] + cost,
            );
        }
        prev.copy_from_slice(&curr);
    }
    prev[n]
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClosestAliasResult {
    pub suggestion: String,
    pub distance: usize,
}

pub fn closest_alias(name: &str, known_list: &[&str]) -> Option<ClosestAliasResult> {
    let mut best: Option<&str> = None;
    let mut best_dist = usize::MAX;

    for &candidate in known_list {
        let dist = edit_distance(name, candidate);
        if dist < best_dist {
            best_dist = dist;
            best = Some(candidate);
        }
    }

    let name_len = name.chars().count();
    let ceil_len_div_3 = name_len.div_ceil(3);

    if let Some(candidate) = best {
        if best_dist <= 3 && best_dist <= ceil_len_div_3 {
            return Some(ClosestAliasResult {
                suggestion: candidate.to_string(),
                distance: best_dist,
            });
        }
    }
    None
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnknownEnvVar {
    pub name: String,
    pub secret: bool,
    pub suggestion: Option<String>,
    pub distance: Option<usize>,
}

pub fn detect_unknown_env_vars(env: &BTreeMap<String, String>) -> Vec<UnknownEnvVar> {
    let known = known_env_aliases();
    let known_list: Vec<&str> = known.to_vec();
    let prefixes = ["MORPHEUS_", "NITRO_"];
    let mut unknown = Vec::new();

    for (name, val) in env {
        if DIRECT_CONTROL_ENV_KEYS.contains(&name.as_str()) {
            continue;
        }
        if !prefixes.iter().any(|p| name.starts_with(p)) {
            continue;
        }
        if known.contains(&name.as_str()) {
            continue;
        }
        if val.trim().is_empty() {
            continue;
        }

        let closest = closest_alias(name, &known_list);
        unknown.push(UnknownEnvVar {
            name: name.clone(),
            secret: is_secret_env_name(name),
            suggestion: closest.as_ref().map(|c| c.suggestion.clone()),
            distance: closest.as_ref().map(|c| c.distance),
        });
    }

    unknown.sort_by(|a, b| a.name.cmp(&b.name));
    unknown
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolvedSettingReport {
    pub key: String,
    pub required: bool,
    pub secret: bool,
    pub set: bool,
    pub source: String,
    pub winning_alias: Option<String>,
    pub aliases: Vec<String>,
    pub default: String,
    pub description: String,
    pub value: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConfigReport {
    pub settings: Vec<ResolvedSettingReport>,
}

pub fn parse_runtime_config(env: &BTreeMap<String, String>) -> BTreeMap<String, Value> {
    let raw = env
        .get("MORPHEUS_RUNTIME_CONFIG_JSON")
        .map(|s| s.trim())
        .unwrap_or("");
    if raw.is_empty() {
        return BTreeMap::new();
    }
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Object(map)) => map.into_iter().collect(),
        _ => BTreeMap::new(),
    }
}

pub struct ResolvedAlias {
    pub value: String,
    pub alias: Option<String>,
    pub source: String,
}

pub fn resolve_alias(
    aliases: &[&str],
    env: &BTreeMap<String, String>,
    runtime_config: &BTreeMap<String, Value>,
) -> ResolvedAlias {
    for &name in aliases {
        if let Some(direct) = env.get(name) {
            let direct = direct.trim();
            if !direct.is_empty() {
                return ResolvedAlias {
                    value: direct.to_string(),
                    alias: Some(name.to_string()),
                    source: "env".to_string(),
                };
            }
        }
    }

    for &name in aliases {
        if let Some(packed) = runtime_config.get(name) {
            if !packed.is_null() {
                let s = match packed {
                    Value::String(s) => s.trim().to_string(),
                    Value::Number(n) => n.to_string(),
                    Value::Bool(b) => b.to_string(),
                    _ => packed.to_string(),
                };
                if !s.is_empty() {
                    return ResolvedAlias {
                        value: s,
                        alias: Some(name.to_string()),
                        source: "runtime_config_json".to_string(),
                    };
                }
            }
        }
    }

    ResolvedAlias {
        value: String::new(),
        alias: None,
        source: "default".to_string(),
    }
}

pub fn is_secret_setting(setting: &ConfigSetting) -> bool {
    if setting.secret {
        return true;
    }
    setting
        .aliases
        .iter()
        .any(|alias| is_secret_env_name(alias))
}

pub fn resolve_config_report(env: &BTreeMap<String, String>) -> ConfigReport {
    let runtime_config = parse_runtime_config(env);
    let settings = CONFIG_SCHEMA
        .iter()
        .map(|setting| {
            let resolved = resolve_alias(setting.aliases, env, &runtime_config);
            let secret = is_secret_setting(setting);
            let is_set = resolved.source != "default";
            let val = if is_set {
                if secret {
                    Some(REDACTED.to_string())
                } else {
                    Some(resolved.value)
                }
            } else {
                None
            };

            ResolvedSettingReport {
                key: setting.key.to_string(),
                required: setting.required,
                secret,
                set: is_set,
                source: resolved.source,
                winning_alias: resolved.alias,
                aliases: setting.aliases.iter().map(|s| s.to_string()).collect(),
                default: setting.default.to_string(),
                description: setting.description.to_string(),
                value: val,
            }
        })
        .collect();

    ConfigReport { settings }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ValidationError {
    pub key: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ValidationWarning {
    pub name: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ValidationResult {
    pub ok: bool,
    pub network: Option<String>,
    pub mode: Option<String>,
    pub active_chains: Option<Vec<String>>,
    pub errors: Vec<ValidationError>,
    pub warnings: Vec<ValidationWarning>,
    pub unknown_env_vars: Vec<UnknownEnvVar>,
}

struct DynamicRequirement {
    key: &'static str,
    present: bool,
    reason: &'static str,
}

fn dynamic_requirements(config: &Value) -> Vec<DynamicRequirement> {
    let mut requirements = Vec::new();
    let active_chains = config
        .get("activeChains")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|x| x.as_str()).collect::<Vec<&str>>())
        .unwrap_or_default();

    let neo_active = active_chains.is_empty() || active_chains.contains(&"neo_n3");
    let neox_active = active_chains.contains(&"neox");
    let mode = config
        .get("mode")
        .and_then(|v| v.as_str())
        .unwrap_or("combined");
    let requests_lane = mode != "feed_only";
    let feed_enabled = config
        .pointer("/feedSync/enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if mode == "feed_only" {
        requirements.push(DynamicRequirement {
            key: "feedSync.enabled",
            present: feed_enabled,
            reason: "feed_only mode must enable its only delivery lane",
        });
    }
    let feed_lane = mode != "requests_only" && feed_enabled;

    if (requests_lane || feed_lane) && (neo_active || neox_active) {
        let custody_url = config
            .pointer("/nitro/custodyUrl")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        requirements.push(DynamicRequirement {
            key: "nitro.custodyUrl",
            present: !custody_url.is_empty(),
            reason: "active request/feed chains sign only through the custody signer service",
        });

        let custody_token = config
            .pointer("/nitro/custodyToken")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        requirements.push(DynamicRequirement {
            key: "nitro.custodyToken",
            present: !custody_token.is_empty(),
            reason: "active request/feed chains require authenticated custody calls",
        });
    }

    if requests_lane && (neo_active || neox_active) {
        let enclave_enabled = config
            .pointer("/nitro/enclaveFulfill")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        requirements.push(DynamicRequirement {
            key: "nitro.enclaveFulfill",
            present: enclave_enabled,
            reason: "authoritative request processing must run inside the measured Rust host",
        });
        let enclave_url = config
            .pointer("/nitro/enclaveFulfillUrl")
            .or_else(|| config.pointer("/nitro/apiUrl"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        requirements.push(DynamicRequirement {
            key: "nitro.enclaveFulfillUrl",
            present: !enclave_url.is_empty(),
            reason: "an active request chain requires the measured /oracle/fulfill host",
        });
    }

    if feed_lane {
        let api_url = config
            .pointer("/nitro/apiUrl")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        requirements.push(DynamicRequirement {
            key: "nitro.apiUrl",
            present: !api_url.is_empty(),
            reason: "enabled feed sync requires the measured /feed/sign host",
        });
        let symbols_present = config
            .pointer("/feedSync/symbols")
            .and_then(Value::as_array)
            .is_some_and(|symbols| {
                symbols
                    .iter()
                    .any(|value| value.as_str().is_some_and(|value| !value.trim().is_empty()))
            });
        requirements.push(DynamicRequirement {
            key: "feedSync.symbols",
            present: symbols_present,
            reason: "enabled feed sync requires at least one symbol",
        });
    }

    if (requests_lane || feed_lane) && (neo_active || neox_active) {
        let runtime_token = config
            .pointer("/nitro/token")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        requirements.push(DynamicRequirement {
            key: "nitro.token",
            present: !runtime_token.is_empty(),
            reason: "measured fulfillment/feed calls require the runtime bearer token",
        });
    }

    if neo_active && (requests_lane || feed_lane) {
        let rpc_urls_present = config
            .pointer("/neo_n3/rpcUrls")
            .and_then(Value::as_array)
            .is_some_and(|urls| {
                urls.iter()
                    .any(|value| value.as_str().is_some_and(|value| !value.trim().is_empty()))
            });
        requirements.push(DynamicRequirement {
            key: "neo_n3.rpcUrls",
            present: rpc_urls_present,
            reason: "an active Neo N3 request/feed lane requires an RPC URL",
        });
        let network_magic_present = config
            .pointer("/neo_n3/networkMagic")
            .and_then(|value| {
                value
                    .as_u64()
                    .or_else(|| value.as_f64().map(|value| value as u64))
            })
            .is_some_and(|value| value > 0);
        requirements.push(DynamicRequirement {
            key: "neo_n3.networkMagic",
            present: network_magic_present,
            reason: "an active Neo N3 request/feed lane must bind its signing network",
        });
        let updater = config
            .pointer("/neo_n3/custodyKeyIds/updater")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        requirements.push(DynamicRequirement {
            key: "neo_n3.custodyKeyIds.updater",
            present: !updater.is_empty(),
            reason: "Neo N3 request/feed signing runs through the updater custody key",
        });
    }

    if neo_active && requests_lane {
        let oracle_contract = config
            .pointer("/neo_n3/oracleContract")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        requirements.push(DynamicRequirement {
            key: "neo_n3.oracleContract",
            present: !oracle_contract.is_empty(),
            reason: "neo_n3 is active and mode is not feed_only",
        });
    }

    if neo_active && feed_lane {
        let datafeed = config
            .pointer("/neo_n3/datafeedContract")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        requirements.push(DynamicRequirement {
            key: "neo_n3.datafeedContract",
            present: !datafeed.is_empty(),
            reason: "Neo N3 feed sync is enabled",
        });
    }

    if neox_active && (requests_lane || feed_lane) {
        let rpc_url = config
            .pointer("/neox/rpcUrl")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        requirements.push(DynamicRequirement {
            key: "neox.rpcUrl",
            present: !rpc_url.is_empty(),
            reason: "an active NeoX request/feed lane requires its primary RPC URL",
        });
        let chain_id_present = config
            .pointer("/neox/chainId")
            .and_then(|value| {
                value
                    .as_u64()
                    .or_else(|| value.as_f64().map(|value| value as u64))
            })
            .is_some_and(|value| value > 0);
        requirements.push(DynamicRequirement {
            key: "neox.chainId",
            present: chain_id_present,
            reason: "an active NeoX request/feed lane must bind its EVM chain id",
        });
        let updater = config
            .pointer("/neox/custodyKeyIds/updater")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        requirements.push(DynamicRequirement {
            key: "neox.custodyKeyIds.updater",
            present: !updater.is_empty(),
            reason: "NeoX request/feed transactions use the updater custody key",
        });
    }

    if neox_active && requests_lane {
        let oracle_contract = config
            .pointer("/neox/oracleContract")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        requirements.push(DynamicRequirement {
            key: "neox.oracleContract",
            present: !oracle_contract.is_empty(),
            reason: "neox is active and mode is not feed_only",
        });

        let verifier = config
            .pointer("/neox/custodyKeyIds/verifier")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        let updater = config
            .pointer("/neox/custodyKeyIds/updater")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        requirements.push(DynamicRequirement {
            key: "neox.custodyKeyIds.verifier",
            present: !verifier.is_empty() && verifier != updater,
            reason: "NeoX request fulfillment requires the distinct EIP-191 verifier custody key",
        });
    }

    if neox_active && feed_lane {
        let datafeed = config
            .pointer("/neox/datafeedContract")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        requirements.push(DynamicRequirement {
            key: "neox.datafeedContract",
            present: !datafeed.is_empty(),
            reason: "NeoX feed sync is enabled",
        });
    }

    requirements
}

pub fn validate_relayer_config(
    env: &BTreeMap<String, String>,
    explicit_config: Option<&Value>,
) -> ValidationResult {
    let report = resolve_config_report(env);
    let report_by_key: BTreeMap<String, &ResolvedSettingReport> =
        report.settings.iter().map(|s| (s.key.clone(), s)).collect();

    let mut errors = Vec::new();
    let mut automation_capability_warning: Option<ValidationWarning> = None;

    let built_config = match explicit_config {
        Some(c) => Some(c.clone()),
        None => {
            // Attempt to derive pure fields
            let mut direct_env = JsObject::new();
            for (key, value) in env {
                direct_env.set(key.clone(), JsValue::Str(value.clone()));
            }
            let mut runtime_env = JsObject::new();
            for (key, value) in parse_runtime_config(env) {
                runtime_env.set(key, JsValue::from_json(&value));
            }
            let env_source = neo_os_core::config::EnvSource::new(direct_env, runtime_env);
            if let Err(message) = crate::config::reject_host_evm_private_keys(&env_source) {
                errors.push(ValidationError {
                    key: "hostEvmPrivateKeys".to_string(),
                    message,
                });
            }
            match neo_os_core::config::derive_pure_fields(
                &env_source,
                &neo_os_core::js_value::JsValue::Undefined,
                "",
            ) {
                Ok(obj) => {
                    let serde_val = crate::config::js_value_to_json(&JsValue::Object(obj));
                    Some(serde_val)
                }
                Err(e) => {
                    errors.push(ValidationError {
                        key: "config".to_string(),
                        message: format!("config could not be built: {e}"),
                    });
                    let unknown_vars = detect_unknown_env_vars(env);
                    let warnings = unknown_vars
                        .iter()
                        .map(|item| ValidationWarning {
                            name: item.name.clone(),
                            message: if let Some(sugg) = &item.suggestion {
                                format!(
                                    "unknown env var \"{}\" does not match any known alias — did you mean \"{}\"? (it is currently ignored)",
                                    item.name, sugg
                                )
                            } else {
                                format!(
                                    "unknown env var \"{}\" does not match any known alias — it is currently ignored",
                                    item.name
                                )
                            },
                        })
                        .collect();

                    let mut all_errors = errors;
                    for setting in &report.settings {
                        if setting.required && !setting.set {
                            all_errors.push(ValidationError {
                                key: setting.key.clone(),
                                message: format!(
                                    "required setting \"{}\" is not set (aliases: {})",
                                    setting.key,
                                    setting.aliases.join(", ")
                                ),
                            });
                        }
                    }

                    return ValidationResult {
                        ok: false,
                        network: None,
                        mode: None,
                        active_chains: None,
                        errors: all_errors,
                        warnings,
                        unknown_env_vars: unknown_vars,
                    };
                }
            }
        }
    };

    // Static requirements
    for setting in &report.settings {
        if setting.required && !setting.set {
            errors.push(ValidationError {
                key: setting.key.clone(),
                message: format!(
                    "required setting \"{}\" is not set (aliases: {})",
                    setting.key,
                    setting.aliases.join(", ")
                ),
            });
        }
    }

    // Dynamic requirements
    if let Some(config) = &built_config {
        for path in ["/neox/updaterPrivateKey", "/neox/verifierPrivateKey"] {
            if config
                .pointer(path)
                .and_then(Value::as_str)
                .is_some_and(|value| !value.trim().is_empty())
            {
                errors.push(ValidationError {
                    key: path.trim_start_matches('/').replace('/', "."),
                    message: "host NeoX/EVM private-key configuration is forbidden in the Rust relayer; use custody key ids instead".to_string(),
                });
            }
        }
        let mode = config
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or("combined");
        // Review P2-16: automation is a bounded capability, not a startup gate.
        // The config validator therefore surfaces it as a warning (the core
        // request/combined runtime still starts) rather than a hard validation
        // error that would block deployment of an otherwise-healthy relayer.
        if mode != "feed_only"
            && config
                .pointer("/automation/enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        {
            automation_capability_warning = Some(ValidationWarning {
                name: "automation.enabled".to_string(),
                message: crate::config::RelayerConfig::AUTOMATION_DELIVERY_UNAVAILABLE.to_string(),
            });
        }
        for req in dynamic_requirements(config) {
            if !req.present {
                let alias_hint = if let Some(entry) = report_by_key.get(req.key) {
                    format!(" (aliases: {})", entry.aliases.join(", "))
                } else {
                    String::new()
                };
                errors.push(ValidationError {
                    key: req.key.to_string(),
                    message: format!(
                        "required setting \"{}\" is not set — {}{alias_hint}",
                        req.key, req.reason
                    ),
                });
            }
        }
    }

    let unknown_env_vars = detect_unknown_env_vars(env);
    let mut warnings: Vec<ValidationWarning> = unknown_env_vars
        .iter()
        .map(|item| ValidationWarning {
            name: item.name.clone(),
            message: if let Some(sugg) = &item.suggestion {
                format!(
                    "unknown env var \"{}\" does not match any known alias — did you mean \"{}\"? (it is currently ignored)",
                    item.name, sugg
                )
            } else {
                format!(
                    "unknown env var \"{}\" does not match any known alias — it is currently ignored",
                    item.name
                )
            },
        })
        .collect();
    if let Some(warning) = automation_capability_warning {
        warnings.push(warning);
    }

    let network = built_config
        .as_ref()
        .and_then(|c| c.get("network"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let mode = built_config
        .as_ref()
        .and_then(|c| c.get("mode"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let active_chains = built_config
        .as_ref()
        .and_then(|c| c.get("activeChains"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        });

    ValidationResult {
        ok: errors.is_empty(),
        network,
        mode,
        active_chains,
        errors,
        warnings,
        unknown_env_vars,
    }
}

pub fn format_config_dump(env: &BTreeMap<String, String>) -> String {
    let report = resolve_config_report(env);
    let mut lines = Vec::new();
    lines.push("# Morpheus relayer — resolved configuration".to_string());
    lines.push("# (secrets redacted; \"source\" shows which alias won)".to_string());
    lines.push(String::new());

    let max_key_len = report
        .settings
        .iter()
        .map(|s| s.key.len())
        .max()
        .unwrap_or(0);

    for setting in &report.settings {
        let padded_key = format!("{:width$}", setting.key, width = max_key_len);
        let display = if !setting.set {
            format!("(default: {})", setting.default)
        } else if setting.secret {
            format!("{REDACTED} [set]")
        } else {
            setting.value.clone().unwrap_or_default()
        };

        let via = if setting.source == "default" {
            "default".to_string()
        } else {
            format!(
                "{} via {}",
                setting.winning_alias.as_deref().unwrap_or("unknown"),
                setting.source
            )
        };

        let flag = if setting.required { " [required]" } else { "" };
        lines.push(format!("{padded_key}  = {display}    ({via}){flag}"));
    }

    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde_json::json;

    use super::validate_relayer_config;

    #[test]
    fn neox_request_mode_requires_measured_host_rpc_and_distinct_custody_keys() {
        let config = json!({
            "network": "testnet",
            "mode": "requests_only",
            "activeChains": ["neox"],
            "nitro": {
                "custodyUrl": "https://signer.internal",
                "custodyToken": "token",
                "token": "runtime-token",
                "enclaveFulfill": true,
                "enclaveFulfillUrl": "https://runtime.internal"
            },
            "neox": {
                "rpcUrl": "https://rpc.internal",
                "chainId": 12227332,
                "oracleContract": "0x1111111111111111111111111111111111111111",
                "custodyKeyIds": {
                    "updater": "neox-updater",
                    "verifier": "neox-verifier"
                }
            }
        });

        let result = validate_relayer_config(&BTreeMap::new(), Some(&config));

        assert!(result.ok, "{:#?}", result.errors);
        assert!(!result
            .errors
            .iter()
            .any(|error| error.key == "neox.updaterPrivateKey"));
        assert!(!result
            .errors
            .iter()
            .any(|error| error.key == "neox.custodyKeyIds.updater"));

        let wrong_chain_key = json!({
            "network": "testnet",
            "mode": "requests_only",
            "activeChains": ["neox"],
            "nitro": {
                "custodyUrl": "https://signer.internal",
                "custodyToken": "token",
                "token": "runtime-token",
                "enclaveFulfill": true,
                "enclaveFulfillUrl": "https://runtime.internal"
            },
            "neox": {
                "rpcUrl": "https://rpc.internal",
                "chainId": 12227332,
                "oracleContract": "0x1111111111111111111111111111111111111111"
            },
            "neo_n3": { "custodyKeyIds": { "updater": "wrong-chain-key" } }
        });
        let wrong_chain_result = validate_relayer_config(&BTreeMap::new(), Some(&wrong_chain_key));
        assert!(wrong_chain_result
            .errors
            .iter()
            .any(|error| error.key == "neox.custodyKeyIds.updater"));
    }

    #[test]
    fn feed_only_validation_fails_before_first_tick_when_delivery_inputs_are_missing() {
        let config = json!({
            "network": "testnet",
            "mode": "feed_only",
            "activeChains": ["neo_n3", "neox"],
            "feedSync": {"enabled": true, "symbols": []},
            "nitro": {}
        });
        let result = validate_relayer_config(&BTreeMap::new(), Some(&config));
        for key in [
            "nitro.custodyUrl",
            "nitro.custodyToken",
            "nitro.apiUrl",
            "nitro.token",
            "feedSync.symbols",
            "neo_n3.rpcUrls",
            "neo_n3.networkMagic",
            "neo_n3.datafeedContract",
            "neo_n3.custodyKeyIds.updater",
            "neox.rpcUrl",
            "neox.chainId",
            "neox.datafeedContract",
            "neox.custodyKeyIds.updater",
        ] {
            assert!(
                result.errors.iter().any(|error| error.key == key),
                "missing preflight error for {key}: {:#?}",
                result.errors
            );
        }
    }

    #[test]
    fn feed_only_validation_refuses_a_disabled_idle_lane() {
        let config = json!({
            "network": "testnet",
            "mode": "feed_only",
            "activeChains": ["neo_n3"],
            "feedSync": {"enabled": false}
        });
        let result = validate_relayer_config(&BTreeMap::new(), Some(&config));
        assert!(result
            .errors
            .iter()
            .any(|error| error.key == "feedSync.enabled"));
    }

    #[test]
    fn validation_rejects_legacy_host_evm_key_even_with_development_opt_in() {
        let env = BTreeMap::from([
            ("NODE_ENV".to_string(), "development".to_string()),
            ("MORPHEUS_RELAYER_MODE".to_string(), "feed_only".to_string()),
            (
                "MORPHEUS_ALLOW_INSECURE_HOST_EVM_SIGNER".to_string(),
                "true".to_string(),
            ),
            (
                "MORPHEUS_RELAYER_NEOX_UPDATER_PK".to_string(),
                "secret".to_string(),
            ),
        ]);

        let result = validate_relayer_config(&env, None);
        assert!(!result.ok);
        let error = result
            .errors
            .iter()
            .find(|error| error.key == "hostEvmPrivateKeys")
            .expect("Rust ownership violation must be reported");
        assert!(error.message.contains("forbidden in the Rust relayer"));
        assert!(!error.message.contains("secret"));
    }
}
