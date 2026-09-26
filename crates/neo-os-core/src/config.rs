//! Relayer config resolution kernel (port of the pure subset of
//! workers/morpheus-relayer/src/config.js): the `env(...)` alias-chain
//! resolver, every env parser primitive, the network-scoped RPC/magic
//! resolution, and the IO-free derivation of `createRelayerConfig()` fields.
//!
//! IO boundaries stay outside this module ON PURPOSE: file reads (network
//! registry JSON, Nitro root cert PEM), hostname/pid and path resolution are
//! supplied by the caller (the enclave host / relayer shell), while everything
//! here is deterministic and pinned by golden vectors
//! (`config_resolution` / `env_for_network` families).
//!
//! Semantics that would silently change behavior if "simplified":
//! - `env()` returns the first alias with a non-empty TRIMMED value —
//!   process.env across ALL aliases first, then the packed runtime config.
//! - `||` chains are JS truthiness chains: the empty string, 0, `false` and
//!   null/undefined all fall through to the next candidate.
//! - `parseNumericEnv` returns the fallback for non-finite results instead of
//!   NaN, because NaN silently defeats every downstream `Math.max` floor
//!   (Math.max(NaN, x) === NaN).

use crate::js_number::{number_to_string, parse_js_number};
use crate::js_value::{js_trim, to_display_string, JsObject, JsValue};
use crate::{CoreError, CoreResult};

/// Chains the relayer can activate, in resolution order.
pub const SUPPORTED_CHAINS: &[&str] = &["neo_n3", "neox"];

/// Last-resort fallback RPC URLs used ONLY when the network registry is
/// absent or its rpc_urls list is empty (port of DEFAULT_NEO_N3_RPC_URLS,
/// mirrored from config/networks/*.json).
///
/// HTTPS ONLY — never add an `http://` endpoint here or to the JS table this
/// ports. A cleartext wallet RPC hop leaks every address and balance query to
/// anyone on the path, and lets an on-path attacker rewrite the response a
/// signing decision is made from. `unique_ranked_rpc_urls` only demotes
/// `http://` to last place, so a single cleartext entry anywhere in the merge
/// order becomes reachable the moment every `https://` node is down — exactly
/// when an attacker who can drop traffic wants it. A short list that fails
/// closed is the intended outcome; the C# SDK (neo-os-sdk `RpcNodeSelector`)
/// and secure-sign's `HttpsRequired` already refuse cleartext.
///
/// `workers/morpheus-relayer/src/rpc-url-ranking.test.mjs` parses this literal
/// and asserts it is https-only and identical to the JS table.
pub static DEFAULT_NEO_N3_RPC_URLS: &[(&str, &[&str])] = &[
    (
        "mainnet",
        &[
            "https://api.n3index.dev/mainnet",
            "https://mainnet1.neo.coz.io:443",
            "https://mainnet2.neo.coz.io:443",
        ],
    ),
    (
        "testnet",
        &[
            "https://api.n3index.dev/testnet",
            "https://testnet1.neo.coz.io:443",
        ],
    ),
];

const MAX_FEED_SYNC_TIMEOUT_MS: f64 = 30_000.0;
const MAX_RETRY_MAX_DELAY_MS: f64 = 600_000.0;
const DEFAULT_NITRO_TIMEOUT_MS: f64 = 10_000.0;
const MAX_REQUEST_TIMEOUT_MS: f64 = 10_000.0;

/// Deterministic stand-in for the Node process: a snapshot of `process.env`
/// plus the parsed `MORPHEUS_RUNTIME_CONFIG_JSON` object. `env()` consults
/// process.env across ALL aliases first, then the runtime config, exactly
/// like the JS oracle.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct EnvSource {
    /// `process.env` snapshot (string values).
    pub process_env: JsObject,
    /// Parsed `MORPHEUS_RUNTIME_CONFIG_JSON` (arbitrary JSON values).
    pub runtime_config: JsObject,
}

impl EnvSource {
    pub fn new(process_env: JsObject, runtime_config: JsObject) -> Self {
        EnvSource {
            process_env,
            runtime_config,
        }
    }

    pub fn empty() -> Self {
        EnvSource::default()
    }
}

/// ECMAScript `String(value)` for the shapes the dynamic code reaches.
/// (Free function re-export here keeps call sites terse.)
fn display(value: &JsValue) -> String {
    to_display_string(value)
}

/// Port of shared `trimString`: `String(value || '').trim()`.
pub fn trim_string(value: &JsValue) -> String {
    if value.truthy() {
        js_trim(&display(value)).to_string()
    } else {
        String::new()
    }
}

/// Port of shared `parseBooleanEnv` (three-way canonical parser): explicit
/// truthy tokens (`1`/`true`/`yes`/`on`) return true, explicit falsy tokens
/// (`0`/`false`/`no`/`off`) return false, anything else — including
/// undefined/empty — returns the fallback.
pub fn parse_boolean_env(value: &JsValue, fallback: bool) -> bool {
    let raw = trim_string(value).to_lowercase();
    match raw.as_str() {
        "" => fallback,
        "1" | "true" | "yes" | "on" => true,
        "0" | "false" | "no" | "off" => false,
        _ => fallback,
    }
}

/// Port of config.js `parseList`: trim the whole value, split on ",", trim
/// each entry, drop empties. Empty input yields an empty list.
pub fn parse_list(value: &JsValue) -> Vec<String> {
    let raw = trim_string(value);
    if raw.is_empty() {
        return Vec::new();
    }
    raw.split(',')
        .map(|entry| js_trim(entry).to_string())
        .filter(|entry| !entry.is_empty())
        .collect()
}

/// Port of config.js `parseUrlList`: String(value||'') (no whole-value trim),
/// split on ",", trim each entry, strip ONE trailing "/", drop empties.
pub fn parse_url_list(value: &JsValue) -> Vec<String> {
    let raw = if value.truthy() {
        display(value)
    } else {
        String::new()
    };
    raw.split(',')
        .map(|entry| {
            let trimmed = js_trim(entry);
            trimmed.strip_suffix('/').unwrap_or(trimmed).to_string()
        })
        .filter(|entry| !entry.is_empty())
        .collect()
}

/// Port of config.js `uniqueOrdered`: drop empties, de-dup preserving order.
pub fn unique_ordered(values: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for value in values {
        if value.is_empty() || out.contains(&value) {
            continue;
        }
        out.push(value);
    }
    out
}

/// Port of config.js `rpcUrlRank`: HTTPS outranks everything, plaintext HTTP
/// sorts last so a MITM-able cleartext endpoint is never PREFERRED.
pub fn rpc_url_rank(value: &str) -> u8 {
    let normalized = js_trim(value).to_lowercase();
    if normalized.starts_with("https://") {
        0
    } else if normalized.starts_with("http://") {
        2
    } else {
        1
    }
}

/// Port of config.js `uniqueRankedRpcUrls`: stable sort by rank after
/// de-duplication (JS Array#sort is stable, and so is Rust's sort_by_key).
pub fn unique_ranked_rpc_urls(values: Vec<String>) -> Vec<String> {
    let mut unique = unique_ordered(values);
    unique.sort_by_key(|value| rpc_url_rank(value));
    unique
}

pub fn require_https_rpc_urls(values: Vec<String>, label: &str) -> CoreResult<Vec<String>> {
    let urls = unique_ordered(values);
    let invalid: Vec<String> = urls
        .iter()
        .filter(|value| !value.to_ascii_lowercase().starts_with("https://"))
        .cloned()
        .collect();
    if !invalid.is_empty() {
        return Err(CoreError::new(format!(
            "{label} requires HTTPS RPC endpoints: {}",
            invalid.join(", ")
        )));
    }
    Ok(urls)
}

/// Port of config.js `parseActiveChains`: lowercase, keep supported chains,
/// fall back to `['neo_n3']` when nothing supported remains.
pub fn parse_active_chains(value: &JsValue) -> Vec<String> {
    let requested: Vec<String> = parse_list(value)
        .into_iter()
        .map(|entry| entry.to_lowercase())
        .collect();
    let filtered: Vec<String> = requested
        .into_iter()
        .filter(|entry| SUPPORTED_CHAINS.contains(&entry.as_str()))
        .collect();
    if filtered.is_empty() {
        vec!["neo_n3".to_string()]
    } else {
        filtered
    }
}

/// Port of config.js `parseIntegerString`: digits-only strings pass through
/// VERBATIM (they are fixed8 GAS amounts — string semantics), anything else
/// returns the fallback string.
pub fn parse_integer_string(value: &JsValue, fallback: &str) -> String {
    let raw = trim_string(value);
    if !raw.is_empty() && raw.bytes().all(|b| b.is_ascii_digit()) {
        raw
    } else {
        fallback.to_string()
    }
}

/// Port of config.js `parseNumericEnv`: `Number(env || default)` semantics
/// for empty and valid input, but the fallback for a non-finite (mistyped)
/// value instead of NaN (NaN would defeat every Math.max floor downstream).
pub fn parse_numeric_env(value: &JsValue, fallback: f64) -> f64 {
    let raw = trim_string(value);
    if raw.is_empty() {
        return fallback;
    }
    let parsed = parse_js_number(&raw);
    if parsed.is_finite() {
        parsed
    } else {
        fallback
    }
}

/// Port of config.js `resolveRelayerMode`: lowercase feed_only/requests_only
/// pass through, everything else normalizes to `combined`.
pub fn resolve_relayer_mode(value: &JsValue) -> String {
    let normalized = trim_string(value).to_lowercase();
    if normalized == "feed_only" || normalized == "requests_only" {
        normalized
    } else {
        "combined".to_string()
    }
}

/// Port of shared neo-signers-core `normalizeMorpheusNetwork`: exactly
/// 'mainnet' (after trim+lowercase) selects mainnet, everything else —
/// including empty — is testnet.
pub fn normalize_morpheus_network(value: &JsValue) -> String {
    let raw = if value.truthy() {
        display(value)
    } else {
        String::new()
    };
    match js_trim(&raw).to_lowercase().as_str() {
        "" => "testnet".to_string(),
        "mainnet" => "mainnet".to_string(),
        "testnet" => "testnet".to_string(),
        other => panic!("unsupported Neo network: {other}"),
    }
}

/// `Math.max(a, b)` with JS NaN semantics (Rust's f64::max swallows NaN —
/// Math.max(NaN, x) is NaN).
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

/// `Math.min(a, b)` with JS NaN semantics.
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

impl EnvSource {
    /// Port of config.js `env(...names)`: the first alias with a non-empty
    /// trimmed process.env value wins; otherwise the first alias whose
    /// runtime-config entry stringifies non-empty wins; otherwise ''.
    pub fn env(&self, names: &[&str]) -> String {
        for name in names {
            if let Some(direct) = self.process_env.get(name) {
                let trimmed = trim_string(direct);
                if !trimmed.is_empty() {
                    return trimmed;
                }
            }
        }
        for name in names {
            if let Some(packed) = self.runtime_config.get(name) {
                if !matches!(packed, JsValue::Undefined | JsValue::Null) {
                    let rendered = display(packed);
                    let trimmed = js_trim(&rendered).to_string();
                    if !trimmed.is_empty() {
                        return trimmed;
                    }
                }
            }
        }
        String::new()
    }

    /// Port of config.js `envNetworkScoped`: `<KEY>_<MAINNET|TESTNET>` wins
    /// over the generic `<KEY>`.
    pub fn env_network_scoped(&self, network: &str, generic_key: &str) -> String {
        let suffix = if network == "mainnet" {
            "MAINNET"
        } else {
            "TESTNET"
        };
        let scoped = self.env(&[&format!("{generic_key}_{suffix}")]);
        if !scoped.is_empty() {
            return scoped;
        }
        self.env(&[generic_key])
    }
}

/// Port of config.js `resolveAllowLocalClaimDuringBackoff`: never allowed in
/// production (multi-instance double-delivery window).
pub fn resolve_allow_local_claim_during_backoff(node_env: &str, requested: bool) -> bool {
    if js_trim(node_env).to_lowercase() == "production" {
        return false;
    }
    requested
}

/// Port of config.js `resolveDurableQueueFailClosed`: always fail closed in
/// production; otherwise honor the requested flag.
pub fn resolve_durable_queue_fail_closed(node_env: &str, requested: bool) -> bool {
    if js_trim(node_env).to_lowercase() == "production" {
        return true;
    }
    requested
}

/// Port of config.js `resolvePublicRuntimeCandidates`: registry `nitro` key,
/// then the two public meshmini edges per network.
pub fn resolve_public_runtime_candidates(network: &str, registry: &JsValue) -> Vec<String> {
    let registry_url = registry
        .get("nitro")
        .and_then(|rr| rr.get("public_api_url"))
        .map(trim_string)
        .unwrap_or_default();
    unique_ordered(vec![
        registry_url,
        format!("https://oracle.meshmini.app/{network}"),
        format!("https://edge.meshmini.app/{network}"),
    ])
}

/// Port of config.js `resolveNitroApiUrls`: explicit scoped/global runtime
/// URL aliases first, optional public fallbacks appended, joined with ",".
pub fn resolve_nitro_api_urls(
    network: &str,
    source: &EnvSource,
    registry: &JsValue,
    allow_public_fallbacks: bool,
) -> String {
    let net_upper = network.to_uppercase();
    let explicit = unique_ordered(parse_url_list(&JsValue::Str(source.env(&[
        &format!("MORPHEUS_{net_upper}_RUNTIME_URL"),
        "MORPHEUS_RUNTIME_URL",
        &format!("MORPHEUS_{net_upper}_NITRO_API_URL"),
        "NITRO_API_URL",
    ]))));
    let public_fallbacks = if allow_public_fallbacks {
        resolve_public_runtime_candidates(network, registry)
    } else {
        Vec::new()
    };
    let mut combined = explicit;
    combined.extend(public_fallbacks);
    unique_ordered(combined).join(",")
}

/// Port of config.js `resolveNeoN3RpcUrls`: scoped aliases, registry list,
/// registry single URL, generic aliases (when allowed), then the built-in
/// seeds — de-duplicated and HTTPS-first ranked.
pub fn resolve_neo_n3_rpc_urls(
    network: &str,
    source: &EnvSource,
    registry: &JsValue,
) -> CoreResult<Vec<String>> {
    let (scoped_aliases, generic_default) = if network == "mainnet" {
        (
            [
                "NEO_MAINNET_RPC_URLS",
                "MAINNET_RPC_URLS",
                "NEO_RPC_URLS_MAINNET",
                "NEO_MAINNET_RPC_URL",
                "MAINNET_RPC_URL",
                "NEO_RPC_MAINNET",
            ],
            "mainnet",
        )
    } else {
        (
            [
                "NEO_TESTNET_RPC_URLS",
                "TESTNET_RPC_URLS",
                "NEO_RPC_URLS_TESTNET",
                "NEO_TESTNET_RPC_URL",
                "TESTNET_RPC_URL",
                "NEO_RPC_TESTNET",
            ],
            "testnet",
        )
    };
    let scoped_rpc_urls = parse_url_list(&JsValue::Str(source.env(&scoped_aliases)));
    let generic_rpc_urls =
        parse_url_list(&JsValue::Str(source.env(&["NEO_RPC_URLS", "NEO_RPC_URL"])));

    let neo_n3 = registry.get("neo_n3");
    let registry_urls = match neo_n3 {
        Some(n3) => {
            let raw = n3.get("rpc_urls").cloned().unwrap_or(JsValue::Undefined);
            // JS: registry.neo_n3?.rpc_urls || [] — empty array is truthy but
            // String([]) is '' which parses to no URLs; undefined/null/0/false
            // all fall through to [].
            let val = if raw.truthy() {
                raw
            } else {
                JsValue::Array(Vec::new())
            };
            parse_url_list(&val)
        }
        None => Vec::new(),
    };
    let registry_single = match neo_n3 {
        Some(n3) => trim_string(&n3.get("rpc_url").cloned().unwrap_or(JsValue::Undefined)),
        None => String::new(),
    };
    let allow_generic = parse_boolean_env(
        &JsValue::Str(source.env(&["ALLOW_GENERIC_NEO_RPC_URL"])),
        false,
    );
    let defaults: Vec<String> = DEFAULT_NEO_N3_RPC_URLS
        .iter()
        .find(|(net, _)| *net == generic_default)
        .map(|(_, urls)| urls.iter().map(|u| u.to_string()).collect())
        .unwrap_or_default();

    let mut all = scoped_rpc_urls;
    all.extend(registry_urls);
    all.push(registry_single);
    if allow_generic {
        all.extend(generic_rpc_urls);
    }
    all.extend(defaults);
    require_https_rpc_urls(
        unique_ranked_rpc_urls(all),
        &format!("Neo N3 {network} RPC"),
    )
}

/// Port of config.js `resolveNeoN3NetworkMagic`: the reviewed registry value is
/// authoritative. Environment values are consistency assertions only; a
/// mismatch returns NaN so startup validation fails closed instead of signing
/// with a caller supplied network magic.
pub fn resolve_neo_n3_network_magic(network: &str, source: &EnvSource, registry: &JsValue) -> f64 {
    let scoped = if network == "mainnet" {
        source.env(&["NEO_MAINNET_MAGIC", "MAINNET_NETWORK_MAGIC"])
    } else {
        source.env(&["NEO_TESTNET_MAGIC", "TESTNET_NETWORK_MAGIC"])
    };
    let generic = if parse_boolean_env(
        &JsValue::Str(source.env(&["ALLOW_GENERIC_NEO_NETWORK_MAGIC"])),
        false,
    ) {
        source.env(&["NEO_NETWORK_MAGIC"])
    } else {
        String::new()
    };
    let registry_magic: JsValue = registry
        .get("neo_n3")
        .and_then(|n3| n3.get("network_magic"))
        .cloned()
        .unwrap_or(JsValue::Undefined);
    let configured = if !scoped.is_empty() { scoped } else { generic };
    let expected = match crate::network_identity::known_neo_n3_identity(network) {
        Some(identity) => identity.magic as f64,
        None => return f64::NAN,
    };
    let reviewed = match registry_magic {
        JsValue::Number(value)
            if value.is_finite() && value.fract() == 0.0 && value > 0.0 && value == expected =>
        {
            value
        }
        _ => return f64::NAN,
    };
    if !configured.is_empty() && parse_js_number(&configured) != reviewed {
        return f64::NAN;
    }
    reviewed
}

fn resolve_neox_chain_id(network: &str, source: &EnvSource, registry: &JsValue) -> CoreResult<f64> {
    let registry_chain = registry
        .get("neo_x")
        .and_then(|n| n.get("chain_id"))
        .map(|value| match value {
            JsValue::Number(number) => *number,
            _ => f64::NAN,
        });
    let expected = crate::network_identity::known_neox_chain_id(network)
        .ok_or_else(|| CoreError::new(format!("unsupported Neo network: {network}")))?
        as f64;
    let reviewed = registry_chain
        .ok_or_else(|| CoreError::new(format!("missing reviewed Neo X chain id for {network}")))?;
    if !reviewed.is_finite()
        || reviewed <= 0.0
        || reviewed.fract() != 0.0
        || reviewed > 9_007_199_254_740_991.0
        || reviewed != expected
    {
        return Err(CoreError::new(format!(
            "Neo X chain id conflicts with reviewed {network} identity"
        )));
    }
    let explicit = source.env(&["MORPHEUS_RELAYER_NEOX_CHAIN_ID", "NEOX_CHAIN_ID"]);
    if !explicit.is_empty() && parse_js_number(&explicit) != reviewed {
        return Err(CoreError::new(format!(
            "Neo X chain id conflicts with reviewed {network} identity"
        )));
    }
    Ok(reviewed)
}

/// Port of the `startRequestIds` / `startBlocks` env coercion: a set env is
/// Number()-coerced (which can be NaN for garbage input — kept distinct from
/// null, which JSON.stringify renders as null too but Number.isFinite
/// rejects), an unset env is null.
pub fn resolve_start_ref(raw_env: &str) -> JsValue {
    if raw_env.is_empty() {
        JsValue::Null
    } else {
        JsValue::Number(parse_js_number(raw_env))
    }
}

/// Host Neo N3 key env names the relayer FORBIDS (port of
/// RELAYER_NEO_N3_HOST_KEY_ENV_NAMES): the two legacy WIF names plus
/// MORPHEUS_<ROLE>_NEO_N3_{WIF,PRIVATE_KEY}[<_MAINNET|_TESTNET>].
pub fn relayer_neo_n3_host_key_env_names() -> Vec<String> {
    let mut names = vec!["NEO_N3_WIF".to_string(), "NEO_TESTNET_WIF".to_string()];
    for role in ["WORKER", "RELAYER", "UPDATER", "ORACLE_VERIFIER", "FEED"] {
        for suffix in ["", "_MAINNET", "_TESTNET"] {
            names.push(format!("MORPHEUS_{role}_NEO_N3_WIF{suffix}"));
            names.push(format!("MORPHEUS_{role}_NEO_N3_PRIVATE_KEY{suffix}"));
        }
    }
    names
}

/// Host Neo X key env names (port of RELAYER_NEOX_HOST_KEY_ENV_NAMES).
pub static RELAYER_NEOX_HOST_KEY_ENV_NAMES: &[&str] = &[
    "MORPHEUS_RELAYER_NEOX_UPDATER_PK",
    "MORPHEUS_RELAYER_NEOX_VERIFIER_PK",
    "NEOX_UPDATER_PK",
    "NEOX_VERIFIER_PK",
    "NEOX_FEED_PK",
];

/// Port of config.js `configuredHostSignerEnvNames`: every env name (host
/// allowlist ∪ process.env ∪ runtime config keys) that looks like a host
/// signing key AND has a value, sorted (JS default sort = code-unit order).
pub fn configured_host_signer_env_names(source: &EnvSource) -> Vec<String> {
    let mut candidates: Vec<String> = Vec::new();
    let push_unique = |name: String, out: &mut Vec<String>| {
        if !out.contains(&name) {
            out.push(name);
        }
    };
    for name in relayer_neo_n3_host_key_env_names() {
        push_unique(name, &mut candidates);
    }
    for name in RELAYER_NEOX_HOST_KEY_ENV_NAMES {
        push_unique(name.to_string(), &mut candidates);
    }
    for (name, _) in source.process_env.iter() {
        push_unique(name.to_string(), &mut candidates);
    }
    for (name, _) in source.runtime_config.iter() {
        push_unique(name.to_string(), &mut candidates);
    }

    let mut matched: Vec<String> = candidates
        .into_iter()
        .filter(|name| {
            let normalized = name.to_uppercase();
            has_word_fragment(&normalized, "WIF")
                || ((has_word_fragment(&normalized, "PRIVATE_KEY")
                    || has_word_fragment(&normalized, "PK"))
                    && ["NEO", "NEOX", "EVM", "MORPHEUS", "SIGNER"]
                        .iter()
                        .any(|frag| normalized.contains(frag)))
        })
        .filter(|name| !source.env(&[name]).is_empty())
        .collect();
    matched.sort();
    matched
}

/// JS regex `(?:^|_)FRAG(?:_|$)` — the fragment must be delimited by string
/// boundaries or underscores.
fn has_word_fragment(haystack: &str, fragment: &str) -> bool {
    let bytes = haystack.as_bytes();
    let pat = fragment.as_bytes();
    if pat.is_empty() || pat.len() > bytes.len() {
        return false;
    }
    for start in 0..=(bytes.len() - pat.len()) {
        if &bytes[start..start + pat.len()] != pat {
            continue;
        }
        let before_ok = start == 0 || bytes[start - 1] == b'_';
        let end = start + pat.len();
        let after_ok = end == bytes.len() || bytes[end] == b'_';
        if before_ok && after_ok {
            return true;
        }
    }
    false
}

/// The default local state-file NAME for a mode (port of the stateFile
/// fallback inside createRelayerConfig; the caller resolves it against its
/// repo root — path logic stays outside this kernel).
pub fn default_state_file_name(mode: &str) -> String {
    if mode == "combined" {
        ".morpheus-relayer-state.json".to_string()
    } else {
        format!(".morpheus-relayer-state.{mode}.json")
    }
}

/// IO-free derivation of every `createRelayerConfig()` field that does not
/// need the filesystem, hostname or pid. `cert_file_fallback` is the caller's
/// read of `MORPHEUS_NITRO_ROOT_CERT_PATH` (empty when unset — the JS oracle
/// reads the file; the vectors only exercise the unset path). Returns the
/// config object with the JS object's key order (repoRoot/stateFile/
/// instanceId are caller-supplied and omitted) or the exact JS gate error.
pub fn derive_pure_fields(
    source: &EnvSource,
    registry: &JsValue,
    cert_file_fallback: &str,
) -> CoreResult<JsObject> {
    let network = {
        let raw = source.env(&["MORPHEUS_NETWORK", "NEXT_PUBLIC_MORPHEUS_NETWORK"]);
        crate::network_identity::resolve_reviewed_network(if raw.is_empty() {
            None
        } else {
            Some(raw.as_str())
        })?
    };
    let node_env_value: JsValue = {
        // JS: trimString(env('NODE_ENV') || process.env.NODE_ENV)
        let from_env = source.env(&["NODE_ENV"]);
        let raw = if !from_env.is_empty() {
            from_env
        } else {
            source
                .process_env
                .get("NODE_ENV")
                .map(display)
                .unwrap_or_default()
        };
        JsValue::Str(trim_string(&JsValue::Str(raw)))
    };
    let production = display(&node_env_value).to_lowercase() == "production";
    // Un-trimmed env('NODE_ENV') || process.env.NODE_ENV for the two
    // durable-queue resolvers (they trim internally).
    let node_env_raw_for_resolvers: String = {
        let from_env = source.env(&["NODE_ENV"]);
        if !from_env.is_empty() {
            from_env
        } else {
            source
                .process_env
                .get("NODE_ENV")
                .map(display)
                .unwrap_or_default()
        }
    };
    let mode = resolve_relayer_mode(&JsValue::Str({
        let e = source.env(&["MORPHEUS_RELAYER_MODE"]);
        if e.is_empty() {
            "combined".to_string()
        } else {
            e
        }
    }));
    let use_derived_keys = parse_boolean_env(
        &JsValue::Str(source.env(&["NITRO_USE_DERIVED_KEYS"])),
        false,
    );
    let has_supabase_url = !source
        .env(&[
            "SUPABASE_URL",
            "NEXT_PUBLIC_SUPABASE_URL",
            "morpheus_SUPABASE_URL",
        ])
        .is_empty();
    let has_supabase_key = !source
        .env(&[
            "SUPABASE_SECRET_KEY",
            "SUPABASE_SERVICE_ROLE_KEY",
            "morpheus_SUPABASE_SECRET_KEY",
            "morpheus_SUPABASE_SERVICE_ROLE_KEY",
            "SUPABASE_SERVICE_KEY",
        ])
        .is_empty();
    let durable_queue_enabled = parse_boolean_env(
        &JsValue::Str(source.env(&["MORPHEUS_DURABLE_QUEUE_ENABLED"])),
        has_supabase_url && has_supabase_key,
    );
    let active_chains = parse_active_chains(&JsValue::Str({
        let e = source.env(&["MORPHEUS_ACTIVE_CHAINS"]);
        if e.is_empty() {
            "neo_n3".to_string()
        } else {
            e
        }
    }));
    let max_retries = js_max(
        parse_numeric_env(
            &JsValue::Str(source.env(&["MORPHEUS_RELAYER_MAX_RETRIES"])),
            5.0,
        ),
        0.0,
    );
    let host_signer_env_names = configured_host_signer_env_names(source);
    let neox_host_key_env_names: Vec<String> = host_signer_env_names
        .iter()
        .filter(|name| {
            let lower = name.to_lowercase();
            lower.contains("neox") || lower.contains("evm")
        })
        .cloned()
        .collect();
    let neo_n3_host_key_env_names: Vec<String> = host_signer_env_names
        .iter()
        .filter(|name| !neox_host_key_env_names.contains(name))
        .cloned()
        .collect();
    let allow_insecure_host_evm_signer = !production
        && parse_boolean_env(
            &JsValue::Str(source.env(&["MORPHEUS_ALLOW_INSECURE_HOST_EVM_SIGNER"])),
            false,
        );

    // --- The four host-signer / production gates, exact JS error strings ---
    if !neo_n3_host_key_env_names.is_empty() {
        return Err(crate::CoreError::new(format!(
            "host Neo N3 signing key configuration is forbidden in the relayer; \
             use custody key ids instead (configured: {})",
            neo_n3_host_key_env_names.join(", ")
        )));
    }
    if production && !neox_host_key_env_names.is_empty() {
        return Err(crate::CoreError::new(format!(
            "host signing key configuration is forbidden in the production relayer; \
             use custody/enclave signing instead (configured: {})",
            neox_host_key_env_names.join(", ")
        )));
    }
    if !production && !neox_host_key_env_names.is_empty() && !allow_insecure_host_evm_signer {
        return Err(crate::CoreError::new(
            "Neo X host signing is development-only and disabled; remove the EVM private key or set \
             MORPHEUS_ALLOW_INSECURE_HOST_EVM_SIGNER=true for an explicit non-production test",
        ));
    }
    let neo_n3_rpc_urls = resolve_neo_n3_rpc_urls(&network, source, registry)?;
    let allow_fallback_value = !production
        && parse_boolean_env(
            &JsValue::Str(source.env(&["MORPHEUS_RELAYER_ALLOW_RUNTIME_FALLBACKS"])),
            true,
        );
    let nitro_api_url = resolve_nitro_api_urls(&network, source, registry, !production);
    let signer_url = {
        let explicit =
            js_trim(&source.env(&["NITRO_SIGNER_URL", "MORPHEUS_SIGNER_URL"])).to_string();
        if explicit.is_empty() {
            resolve_nitro_api_urls(&network, source, registry, !production)
        } else {
            explicit
        }
    };
    let enclave_fulfill_url = {
        let direct = js_trim(&source.env(&["MORPHEUS_RELAYER_ENCLAVE_FULFILL_URL"])).to_string();
        if !direct.is_empty() {
            direct
        } else {
            let signer =
                js_trim(&source.env(&["NITRO_SIGNER_URL", "MORPHEUS_SIGNER_URL"])).to_string();
            if !signer.is_empty() {
                signer
            } else {
                resolve_nitro_api_urls(&network, source, registry, !production)
            }
        }
    };
    let decrypt_url = {
        let direct = js_trim(&source.env(&[
            "MORPHEUS_RELAYER_ENCLAVE_DECRYPT_URL",
            "MORPHEUS_DECRYPT_URL",
        ]))
        .to_string();
        if !direct.is_empty() {
            direct
        } else {
            let fulfill =
                js_trim(&source.env(&["MORPHEUS_RELAYER_ENCLAVE_FULFILL_URL"])).to_string();
            if !fulfill.is_empty() {
                fulfill
            } else {
                let signer =
                    js_trim(&source.env(&["NITRO_SIGNER_URL", "MORPHEUS_SIGNER_URL"])).to_string();
                if !signer.is_empty() {
                    signer
                } else {
                    resolve_nitro_api_urls(&network, source, registry, !production)
                }
            }
        }
    };
    let nitro_root_cert_pem = {
        let inline = js_trim(&source.env(&["MORPHEUS_NITRO_ROOT_CERT_PEM"])).to_string();
        if inline.is_empty() {
            cert_file_fallback.to_string()
        } else {
            inline
        }
    };

    let mut cfg = JsObject::new();
    cfg.set("network", JsValue::Str(network.clone()));
    cfg.set("nodeEnv", node_env_value.clone());
    cfg.set("mode", JsValue::Str(mode.clone()));
    cfg.set("useDerivedKeys", JsValue::Bool(use_derived_keys));
    cfg.set(
        "activeChains",
        JsValue::Array(
            active_chains
                .iter()
                .map(|c| JsValue::Str(c.clone()))
                .collect(),
        ),
    );
    cfg.set(
        "pollIntervalMs",
        JsValue::Number(parse_numeric_env(
            &JsValue::Str(source.env(&["MORPHEUS_RELAYER_POLL_INTERVAL_MS"])),
            5000.0,
        )),
    );
    cfg.set(
        "discoveryIdleBackoffMs",
        JsValue::Number(js_max(
            parse_numeric_env(
                &JsValue::Str(source.env(&["MORPHEUS_RELAYER_DISCOVERY_IDLE_BACKOFF_MS"])),
                0.0,
            ),
            0.0,
        )),
    );
    cfg.set(
        "concurrency",
        JsValue::Number(js_max(
            parse_numeric_env(
                &JsValue::Str(source.env(&["MORPHEUS_RELAYER_CONCURRENCY"])),
                4.0,
            ),
            1.0,
        )),
    );
    cfg.set(
        "maxBlocksPerTick",
        JsValue::Number(js_max(
            parse_numeric_env(
                &JsValue::Str(source.env(&["MORPHEUS_RELAYER_MAX_BLOCKS_PER_TICK"])),
                250.0,
            ),
            1.0,
        )),
    );
    cfg.set("maxRetries", JsValue::Number(max_retries));
    cfg.set(
        "maxCallbackRetries",
        JsValue::Number(js_max(
            parse_numeric_env(
                &JsValue::Str(source.env(&["MORPHEUS_RELAYER_MAX_CALLBACK_RETRIES"])),
                max_retries * 2.0,
            ),
            1.0,
        )),
    );
    cfg.set(
        "retryBaseDelayMs",
        JsValue::Number(js_max(
            parse_numeric_env(
                &JsValue::Str(source.env(&["MORPHEUS_RELAYER_RETRY_BASE_DELAY_MS"])),
                5000.0,
            ),
            250.0,
        )),
    );
    cfg.set(
        "retryMaxDelayMs",
        JsValue::Number(js_min(
            js_max(
                parse_numeric_env(
                    &JsValue::Str(source.env(&["MORPHEUS_RELAYER_RETRY_MAX_DELAY_MS"])),
                    10_000.0,
                ),
                1000.0,
            ),
            MAX_RETRY_MAX_DELAY_MS,
        )),
    );
    cfg.set(
        "statePersistMinIntervalMs",
        JsValue::Number(js_max(
            parse_numeric_env(
                &JsValue::Str(source.env(&["MORPHEUS_RELAYER_STATE_PERSIST_MIN_INTERVAL_MS"])),
                250.0,
            ),
            0.0,
        )),
    );
    cfg.set(
        "processedCacheSize",
        JsValue::Number(js_max(
            parse_numeric_env(
                &JsValue::Str(source.env(&["MORPHEUS_RELAYER_PROCESSED_CACHE_SIZE"])),
                5000.0,
            ),
            100.0,
        )),
    );
    cfg.set(
        "deadLetterLimit",
        JsValue::Number(js_max(
            parse_numeric_env(
                &JsValue::Str(source.env(&["MORPHEUS_RELAYER_DEAD_LETTER_LIMIT"])),
                500.0,
            ),
            10.0,
        )),
    );
    cfg.set(
        "retryQueueLimit",
        JsValue::Number(js_max(
            parse_numeric_env(
                &JsValue::Str(source.env(&["MORPHEUS_RELAYER_RETRY_QUEUE_LIMIT"])),
                0.0,
            ),
            0.0,
        )),
    );

    // durableQueue
    let mut durable_queue = JsObject::new();
    durable_queue.set("enabled", JsValue::Bool(durable_queue_enabled));
    durable_queue.set(
        "failClosed",
        JsValue::Bool(resolve_durable_queue_fail_closed(
            &node_env_raw_for_resolvers,
            parse_boolean_env(
                &JsValue::Str(source.env(&["MORPHEUS_DURABLE_QUEUE_FAIL_CLOSED"])),
                durable_queue_enabled,
            ),
        )),
    );
    durable_queue.set(
        "allowLocalClaimDuringBackoff",
        JsValue::Bool(resolve_allow_local_claim_during_backoff(
            &node_env_raw_for_resolvers,
            parse_boolean_env(
                &JsValue::Str(
                    source.env(&["MORPHEUS_DURABLE_QUEUE_ALLOW_LOCAL_CLAIM_DURING_BACKOFF"]),
                ),
                false,
            ),
        )),
    );
    durable_queue.set(
        "syncLimit",
        JsValue::Number(js_max(
            parse_numeric_env(
                &JsValue::Str(source.env(&["MORPHEUS_DURABLE_QUEUE_SYNC_LIMIT"])),
                200.0,
            ),
            1.0,
        )),
    );
    durable_queue.set(
        "staleProcessingMs",
        JsValue::Number(js_max(
            parse_numeric_env(
                &JsValue::Str(source.env(&["MORPHEUS_DURABLE_QUEUE_STALE_PROCESSING_MS"])),
                45_000.0,
            ),
            1000.0,
        )),
    );
    cfg.set("durableQueue", JsValue::Object(durable_queue));

    // runSnapshots
    let mut run_snapshots = JsObject::new();
    run_snapshots.set(
        "enabled",
        JsValue::Bool(parse_boolean_env(
            &JsValue::Str(source.env(&["MORPHEUS_RELAYER_RUN_SNAPSHOTS_ENABLED"])),
            true,
        )),
    );
    run_snapshots.set(
        "intervalMs",
        JsValue::Number(js_max(
            parse_numeric_env(
                &JsValue::Str(source.env(&["MORPHEUS_RELAYER_RUN_SNAPSHOT_INTERVAL_MS"])),
                60_000.0,
            ),
            0.0,
        )),
    );
    run_snapshots.set(
        "errorBackoffMs",
        JsValue::Number(js_max(
            parse_numeric_env(
                &JsValue::Str(source.env(&["MORPHEUS_RELAYER_RUN_SNAPSHOT_ERROR_BACKOFF_MS"])),
                300_000.0,
            ),
            1000.0,
        )),
    );
    cfg.set("runSnapshots", JsValue::Object(run_snapshots));

    // backpressure
    let mut backpressure = JsObject::new();
    backpressure.set(
        "maxFreshEventsPerTick",
        JsValue::Number(js_max(
            parse_numeric_env(
                &JsValue::Str(source.env(&["MORPHEUS_RELAYER_MAX_FRESH_EVENTS_PER_TICK"])),
                32.0,
            ),
            1.0,
        )),
    );
    backpressure.set(
        "maxRetryEventsPerTick",
        JsValue::Number(js_max(
            parse_numeric_env(
                &JsValue::Str(source.env(&["MORPHEUS_RELAYER_MAX_RETRY_EVENTS_PER_TICK"])),
                16.0,
            ),
            1.0,
        )),
    );
    backpressure.set(
        "deferDelayMs",
        JsValue::Number(js_max(
            parse_numeric_env(
                &JsValue::Str(source.env(&["MORPHEUS_RELAYER_DEFER_DELAY_MS"])),
                5000.0,
            ),
            250.0,
        )),
    );
    cfg.set("backpressure", JsValue::Object(backpressure));

    // feedSync
    let mut feed_sync = JsObject::new();
    feed_sync.set(
        "enabled",
        JsValue::Bool({
            let e = source.env(&["MORPHEUS_FEED_SYNC_ENABLED"]);
            let raw = if e.is_empty() { "true" } else { e.as_str() };
            raw.to_lowercase() != "false"
        }),
    );
    feed_sync.set(
        "intervalMs",
        JsValue::Number(js_max(
            parse_numeric_env(
                &JsValue::Str(source.env(&["MORPHEUS_FEED_SYNC_INTERVAL_MS"])),
                60_000.0,
            ),
            1000.0,
        )),
    );
    feed_sync.set(
        "timeoutMs",
        JsValue::Number(js_min(
            js_max(
                parse_numeric_env(
                    &JsValue::Str(source.env(&["MORPHEUS_FEED_SYNC_TIMEOUT_MS"])),
                    10_000.0,
                ),
                1000.0,
            ),
            MAX_FEED_SYNC_TIMEOUT_MS,
        )),
    );
    feed_sync.set(
        "waitForSubmission",
        JsValue::Bool(parse_boolean_env(
            &JsValue::Str(source.env(&["MORPHEUS_FEED_SYNC_WAIT_FOR_SUBMISSION"])),
            false,
        )),
    );
    feed_sync.set(
        "projectSlug",
        JsValue::Str({
            let e = source.env(&["MORPHEUS_FEED_PROJECT_SLUG"]);
            if e.is_empty() {
                "morpheus".to_string()
            } else {
                e
            }
        }),
    );
    feed_sync.set(
        "projectConfigEnabled",
        JsValue::Bool(parse_boolean_env(
            &JsValue::Str(source.env(&["MORPHEUS_FEED_SYNC_PROJECT_CONFIG_ENABLED"])),
            false,
        )),
    );
    feed_sync.set(
        "provider",
        JsValue::Str(source.env(&["MORPHEUS_FEED_PROVIDER"])),
    );
    feed_sync.set(
        "providers",
        JsValue::Array(
            parse_list(&JsValue::Str(source.env(&["MORPHEUS_FEED_PROVIDERS"])))
                .into_iter()
                .map(JsValue::Str)
                .collect(),
        ),
    );
    feed_sync.set(
        "symbols",
        JsValue::Array(
            parse_list(&JsValue::Str(source.env(&["MORPHEUS_FEED_SYMBOLS"])))
                .into_iter()
                .map(JsValue::Str)
                .collect(),
        ),
    );
    feed_sync.set(
        "changeThresholdBps",
        JsValue::Str({
            let e = source.env(&["MORPHEUS_FEED_CHANGE_THRESHOLD_BPS"]);
            if e.is_empty() {
                "10".to_string()
            } else {
                e
            }
        }),
    );
    feed_sync.set(
        "minUpdateIntervalMs",
        JsValue::Str({
            let e = source.env(&["MORPHEUS_FEED_MIN_UPDATE_INTERVAL_MS"]);
            if e.is_empty() {
                "60000".to_string()
            } else {
                e
            }
        }),
    );
    feed_sync.set(
        "staleAfterMs",
        JsValue::Str({
            let e = source.env(&["MORPHEUS_FEED_STALE_AFTER_MS"]);
            if e.is_empty() {
                "300000".to_string()
            } else {
                e
            }
        }),
    );
    cfg.set("feedSync", JsValue::Object(feed_sync));

    // automation
    let mut automation = JsObject::new();
    automation.set(
        "enabled",
        JsValue::Bool({
            let e = source.env(&["MORPHEUS_AUTOMATION_ENABLED"]);
            let raw = if e.is_empty() { "true" } else { e.as_str() };
            raw.to_lowercase() != "false"
        }),
    );
    automation.set(
        "batchSize",
        JsValue::Number(js_max(
            parse_numeric_env(
                &JsValue::Str(source.env(&["MORPHEUS_AUTOMATION_BATCH_SIZE"])),
                50.0,
            ),
            1.0,
        )),
    );
    automation.set(
        "maxQueuedPerTick",
        JsValue::Number(js_max(
            parse_numeric_env(
                &JsValue::Str(source.env(&["MORPHEUS_AUTOMATION_MAX_QUEUED_PER_TICK"])),
                10.0,
            ),
            1.0,
        )),
    );
    automation.set(
        "pricePollPairsPerTick",
        JsValue::Number(js_max(
            parse_numeric_env(
                &JsValue::Str(source.env(&["MORPHEUS_AUTOMATION_PRICE_PAIRS_PER_TICK"])),
                25.0,
            ),
            1.0,
        )),
    );
    automation.set(
        "defaultPriceCooldownMs",
        JsValue::Number(js_max(
            parse_numeric_env(
                &JsValue::Str(source.env(&["MORPHEUS_AUTOMATION_DEFAULT_PRICE_COOLDOWN_MS"])),
                60_000.0,
            ),
            0.0,
        )),
    );
    automation.set(
        "claimStaleMs",
        JsValue::Number(js_max(
            parse_numeric_env(
                &JsValue::Str(source.env(&["MORPHEUS_AUTOMATION_CLAIM_STALE_MS"])),
                120_000.0,
            ),
            1000.0,
        )),
    );
    automation.set(
        "idleBackoffMs",
        JsValue::Number(js_max(
            parse_numeric_env(
                &JsValue::Str(source.env(&["MORPHEUS_AUTOMATION_IDLE_BACKOFF_MS"])),
                0.0,
            ),
            0.0,
        )),
    );
    cfg.set("automation", JsValue::Object(automation));

    cfg.set(
        "logFormat",
        JsValue::Str({
            let e = source.env(&["MORPHEUS_RELAYER_LOG_FORMAT", "LOG_FORMAT"]);
            if e.is_empty() {
                "json".to_string()
            } else {
                e
            }
        }),
    );
    cfg.set(
        "logLevel",
        JsValue::Str({
            let e = source.env(&["MORPHEUS_RELAYER_LOG_LEVEL", "LOG_LEVEL"]);
            if e.is_empty() {
                "info".to_string()
            } else {
                e
            }
        }),
    );

    // confirmations / start refs
    let mut confirmations = JsObject::new();
    confirmations.set(
        "neo_n3",
        JsValue::Number(parse_numeric_env(
            &JsValue::Str(source.env(&["MORPHEUS_RELAYER_NEO_N3_CONFIRMATIONS"])),
            1.0,
        )),
    );
    confirmations.set(
        "neox",
        JsValue::Number(parse_numeric_env(
            &JsValue::Str(source.env(&["MORPHEUS_RELAYER_NEOX_CONFIRMATIONS"])),
            2.0,
        )),
    );
    cfg.set("confirmations", JsValue::Object(confirmations));

    let mut start_request_ids = JsObject::new();
    start_request_ids.set(
        "neo_n3",
        resolve_start_ref(&source.env(&["MORPHEUS_RELAYER_NEO_N3_START_REQUEST_ID"])),
    );
    start_request_ids.set(
        "neox",
        resolve_start_ref(&source.env(&["MORPHEUS_RELAYER_NEOX_START_REQUEST_ID"])),
    );
    cfg.set("startRequestIds", JsValue::Object(start_request_ids));

    let mut start_blocks = JsObject::new();
    start_blocks.set(
        "neo_n3",
        resolve_start_ref(&source.env(&["MORPHEUS_RELAYER_NEO_N3_START_BLOCK"])),
    );
    start_blocks.set(
        "neox",
        resolve_start_ref(&source.env(&["MORPHEUS_RELAYER_NEOX_START_BLOCK"])),
    );
    cfg.set("startBlocks", JsValue::Object(start_blocks));

    // nitro
    let raw_node_env = source
        .process_env
        .get("NODE_ENV")
        .map(|v| v.as_str().map(|s| s.to_string()).unwrap_or_default())
        .unwrap_or_default();
    let mut nitro = JsObject::new();
    nitro.set("apiUrl", JsValue::Str(nitro_api_url));
    nitro.set("allowFallback", JsValue::Bool(allow_fallback_value));
    nitro.set("signerUrl", JsValue::Str(signer_url));
    nitro.set(
        "custodyUrl",
        JsValue::Str(js_trim(&source.env(&["SIGNER_SERVICE_URL"])).to_string()),
    );
    nitro.set(
        "custodyToken",
        JsValue::Str(js_trim(&source.env(&["SIGNER_SERVICE_TOKEN"])).to_string()),
    );
    nitro.set(
        "enclaveFulfill",
        JsValue::Bool(parse_boolean_env(
            &JsValue::Str(source.env(&["MORPHEUS_RELAYER_ENCLAVE_FULFILL"])),
            false,
        )),
    );
    nitro.set(
        "expectedPcr0",
        JsValue::Str(js_trim(&source.env(&["MORPHEUS_EXPECTED_PCR0"])).to_string()),
    );
    nitro.set(
        "verifyEnclaveSignature",
        JsValue::Bool(parse_boolean_env(
            &JsValue::Str(source.env(&["MORPHEUS_RELAYER_VERIFY_ENCLAVE_SIGNATURE"])),
            raw_node_env == "production",
        )),
    );
    nitro.set("enclaveFulfillUrl", JsValue::Str(enclave_fulfill_url));
    nitro.set("decryptUrl", JsValue::Str(decrypt_url));
    nitro.set("nitroRootCertPem", JsValue::Str(nitro_root_cert_pem));
    nitro.set(
        "attestationMaxAgeMs",
        JsValue::Number(js_max(
            parse_numeric_env(
                &JsValue::Str(source.env(&["MORPHEUS_ATTESTATION_MAX_AGE_MS"])),
                0.0,
            ),
            0.0,
        )),
    );
    nitro.set(
        "token",
        JsValue::Str(source.env(&[
            "MORPHEUS_RUNTIME_TOKEN",
            "NITRO_API_TOKEN",
            "NITRO_SHARED_SECRET",
        ])),
    );
    nitro.set(
        "timeoutMs",
        JsValue::Number(js_min(
            js_max(
                parse_numeric_env(
                    &JsValue::Str(source.env(&["MORPHEUS_NITRO_TIMEOUT_MS"])),
                    DEFAULT_NITRO_TIMEOUT_MS,
                ),
                1000.0,
            ),
            MAX_REQUEST_TIMEOUT_MS,
        )),
    );
    nitro.set("useDerivedKeys", JsValue::Bool(use_derived_keys));
    cfg.set("nitro", JsValue::Object(nitro));

    // neo_n3
    let mut neo_n3_obj = JsObject::new();
    neo_n3_obj.set(
        "scanMode",
        JsValue::Str({
            let e = js_trim(&source.env(&["MORPHEUS_RELAYER_NEO_N3_SCAN_MODE"])).to_string();
            if e.is_empty() {
                if network == "testnet" {
                    "n3index_notifications".to_string()
                } else {
                    "block_cursor".to_string()
                }
            } else {
                e
            }
        }),
    );
    neo_n3_obj.set(
        "fulfillConfirmTimeoutMs",
        resolve_start_ref(&source.env(&["MORPHEUS_RELAYER_NEO_N3_FULFILL_CONFIRM_TIMEOUT_MS"])),
    );
    neo_n3_obj.set(
        "fulfillConfirmThrowOnTimeout",
        JsValue::Bool(parse_boolean_env(
            &JsValue::Str(
                source.env(&["MORPHEUS_RELAYER_NEO_N3_FULFILL_CONFIRM_THROW_ON_TIMEOUT"]),
            ),
            true,
        )),
    );
    neo_n3_obj.set(
        "indexerUrl",
        JsValue::Str({
            let e = js_trim(&source.env(&["MORPHEUS_RELAYER_NEO_N3_INDEXER_URL"])).to_string();
            if e.is_empty() {
                "https://api.n3index.dev/rest/v1".to_string()
            } else {
                e
            }
        }),
    );
    neo_n3_obj.set(
        "startRequestId",
        resolve_start_ref(&source.env(&["MORPHEUS_RELAYER_NEO_N3_START_REQUEST_ID"])),
    );
    neo_n3_obj.set(
        "rpcUrl",
        JsValue::Str(neo_n3_rpc_urls.first().cloned().unwrap_or_default()),
    );
    neo_n3_obj.set(
        "rpcUrls",
        JsValue::Array(
            neo_n3_rpc_urls
                .iter()
                .map(|u| JsValue::Str(u.clone()))
                .collect(),
        ),
    );
    neo_n3_obj.set(
        "networkMagic",
        JsValue::Number(resolve_neo_n3_network_magic(&network, source, registry)),
    );
    neo_n3_obj.set(
        "oracleContract",
        JsValue::Str({
            let scoped = source.env_network_scoped(&network, "CONTRACT_MORPHEUS_ORACLE_HASH");
            if !scoped.is_empty() {
                scoped
            } else {
                registry
                    .get("neo_n3")
                    .and_then(|n3| n3.get("contracts"))
                    .and_then(|c| c.get("morpheus_oracle"))
                    .map(trim_string)
                    .unwrap_or_default()
            }
        }),
    );
    neo_n3_obj.set(
        "datafeedContract",
        JsValue::Str({
            let scoped = source.env_network_scoped(&network, "CONTRACT_MORPHEUS_DATAFEED_HASH");
            if !scoped.is_empty() {
                scoped
            } else {
                registry
                    .get("neo_n3")
                    .and_then(|n3| n3.get("contracts"))
                    .and_then(|c| c.get("morpheus_datafeed"))
                    .map(trim_string)
                    .unwrap_or_default()
            }
        }),
    );
    let mut custody_key_ids = JsObject::new();
    custody_key_ids.set(
        "updater",
        JsValue::Str(js_trim(&source.env(&["SIGNER_ROLE_UPDATER_KEY_ID"])).to_string()),
    );
    custody_key_ids.set(
        "oracle_verifier",
        JsValue::Str(js_trim(&source.env(&["SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID"])).to_string()),
    );
    custody_key_ids.set(
        "fee_funder",
        JsValue::Str(js_trim(&source.env(&["SIGNER_ROLE_FEE_FUNDER_KEY_ID"])).to_string()),
    );
    neo_n3_obj.set("custodyKeyIds", JsValue::Object(custody_key_ids));
    let mut fee_top_up = JsObject::new();
    fee_top_up.set(
        "enabled",
        JsValue::Bool(parse_boolean_env(
            &JsValue::Str(source.env(&["MORPHEUS_RELAYER_NEO_N3_AUTO_TOPUP_ENABLED"])),
            true,
        )),
    );
    fee_top_up.set(
        "minBalance",
        JsValue::Str(parse_integer_string(
            &JsValue::Str(source.env(&["MORPHEUS_RELAYER_NEO_N3_AUTO_TOPUP_MIN_FIXED8"])),
            "50000000",
        )),
    );
    fee_top_up.set(
        "topUpAmount",
        JsValue::Str(parse_integer_string(
            &JsValue::Str(source.env(&["MORPHEUS_RELAYER_NEO_N3_AUTO_TOPUP_AMOUNT_FIXED8"])),
            "100000000",
        )),
    );
    fee_top_up.set(
        "maxTopUpAmount",
        JsValue::Str(parse_integer_string(
            &JsValue::Str(source.env(&["MORPHEUS_RELAYER_NEO_N3_AUTO_TOPUP_MAX_FIXED8"])),
            "500000000",
        )),
    );
    neo_n3_obj.set("feeTopUp", JsValue::Object(fee_top_up));
    cfg.set("neo_n3", JsValue::Object(neo_n3_obj));

    // neox
    let neox_primary_rpc = {
        let explicit =
            js_trim(&source.env(&["MORPHEUS_RELAYER_NEOX_RPC_URL", "NEOX_RPC"])).to_string();
        if !explicit.is_empty() {
            explicit
        } else {
            let registry_url = registry
                .get("neo_x")
                .and_then(|n| n.get("rpc_url"))
                .map(trim_string)
                .unwrap_or_default();
            if !registry_url.is_empty() {
                registry_url
            } else if network == "mainnet" {
                "https://mainnet-1.rpc.banelabs.org".to_string()
            } else {
                "https://neoxt4seed1.ngd.network".to_string()
            }
        }
    };
    let neox_rpc_urls = {
        let mut list = vec![neox_primary_rpc.clone()];
        list.extend(parse_url_list(&JsValue::Str(
            source.env(&["MORPHEUS_RELAYER_NEOX_RPC_URLS", "NEOX_RPC_URLS"]),
        )));
        if let Some(neox_reg) = registry.get("neo_x") {
            let raw = neox_reg
                .get("rpc_urls")
                .cloned()
                .unwrap_or(JsValue::Undefined);
            let val = if raw.truthy() {
                raw
            } else {
                JsValue::Array(Vec::new())
            };
            list.extend(parse_url_list(&val));
        }
        if network == "mainnet" {
            list.push("https://mainnet-1.rpc.banelabs.org".to_string());
            list.push("https://mainnet-2.rpc.banelabs.org".to_string());
        } else {
            list.push("https://neoxt4seed1.ngd.network".to_string());
            list.push("https://neoxt4seed2.ngd.network".to_string());
        }
        require_https_rpc_urls(list, &format!("Neo X {network} RPC"))?
    };
    let mut neox_obj = JsObject::new();
    neox_obj.set(
        "scanMode",
        JsValue::Str({
            let e = js_trim(&source.env(&["MORPHEUS_RELAYER_NEOX_SCAN_MODE"])).to_string();
            if e.is_empty() {
                "request_cursor".to_string()
            } else {
                e
            }
        }),
    );
    neox_obj.set("rpcUrl", JsValue::Str(neox_primary_rpc.clone()));
    neox_obj.set(
        "rpcUrls",
        JsValue::Array(neox_rpc_urls.into_iter().map(JsValue::Str).collect()),
    );
    neox_obj.set(
        "chainId",
        JsValue::Number(resolve_neox_chain_id(&network, source, registry)?),
    );
    neox_obj.set(
        "oracleContract",
        JsValue::Str({
            let explicit =
                js_trim(&source.env(&["MORPHEUS_RELAYER_NEOX_ORACLE", "NEOX_ORACLE"])).to_string();
            if !explicit.is_empty() {
                explicit
            } else {
                registry
                    .get("neo_x")
                    .and_then(|n| n.get("contracts"))
                    .and_then(|c| c.get("morpheus_oracle"))
                    .map(trim_string)
                    .unwrap_or_default()
            }
        }),
    );
    neox_obj.set(
        "datafeedContract",
        JsValue::Str({
            let explicit =
                js_trim(&source.env(&["MORPHEUS_RELAYER_NEOX_DATAFEED", "NEOX_DATAFEED"]))
                    .to_string();
            if !explicit.is_empty() {
                explicit
            } else {
                registry
                    .get("neo_x")
                    .and_then(|n| n.get("contracts"))
                    .and_then(|c| c.get("morpheus_datafeed"))
                    .map(trim_string)
                    .unwrap_or_default()
            }
        }),
    );
    neox_obj.set(
        "feedGasLimit",
        JsValue::Number(js_max(
            parse_numeric_env(
                &JsValue::Str(source.env(&["MORPHEUS_RELAYER_NEOX_FEED_GAS_LIMIT"])),
                2_000_000.0,
            ),
            21_000.0,
        )),
    );
    neox_obj.set(
        "allowHostSigner",
        JsValue::Bool(allow_insecure_host_evm_signer),
    );
    let mut neox_custody_key_ids = JsObject::new();
    neox_custody_key_ids.set(
        "updater",
        JsValue::Str(js_trim(&source.env(&["SIGNER_ROLE_NEOX_UPDATER_KEY_ID"])).to_string()),
    );
    neox_custody_key_ids.set(
        "verifier",
        JsValue::Str(js_trim(&source.env(&["SIGNER_ROLE_NEOX_VERIFIER_KEY_ID"])).to_string()),
    );
    neox_obj.set("custodyKeyIds", JsValue::Object(neox_custody_key_ids));
    neox_obj.set(
        "updaterPrivateKey",
        JsValue::Str(if allow_insecure_host_evm_signer {
            js_trim(&source.env(&[
                "MORPHEUS_RELAYER_NEOX_UPDATER_PK",
                "NEOX_UPDATER_PK",
                "NEOX_FEED_PK",
            ]))
            .to_string()
        } else {
            String::new()
        }),
    );
    neox_obj.set(
        "verifierPrivateKey",
        JsValue::Str(if allow_insecure_host_evm_signer {
            js_trim(&source.env(&["MORPHEUS_RELAYER_NEOX_VERIFIER_PK", "NEOX_VERIFIER_PK"]))
                .to_string()
        } else {
            String::new()
        }),
    );
    neox_obj.set(
        "confirmTimeoutMs",
        JsValue::Number(js_max(
            parse_numeric_env(
                &JsValue::Str(source.env(&["MORPHEUS_RELAYER_NEOX_CONFIRM_TIMEOUT_MS"])),
                45_000.0,
            ),
            1000.0,
        )),
    );
    neox_obj.set(
        "workerUrl",
        JsValue::Str({
            js_trim(&source.env(&["MORPHEUS_RELAYER_NEOX_WORKER_URL", "NEOX_WORKER_URL"]))
                .to_string()
        }),
    );
    cfg.set("neox", JsValue::Object(neox_obj));

    // metricsServer
    let mut metrics_server = JsObject::new();
    metrics_server.set(
        "host",
        JsValue::Str({
            let e = source.env(&["MORPHEUS_RELAYER_METRICS_HOST"]);
            if e.is_empty() {
                "127.0.0.1".to_string()
            } else {
                e
            }
        }),
    );
    metrics_server.set(
        "port",
        JsValue::Number(js_max(
            parse_numeric_env(
                &JsValue::Str(source.env(&["MORPHEUS_RELAYER_METRICS_PORT"])),
                9464.0,
            ),
            1.0,
        )),
    );
    metrics_server.set(
        "path",
        JsValue::Str({
            let e = source.env(&["MORPHEUS_RELAYER_METRICS_PATH"]);
            if e.is_empty() {
                "/metrics".to_string()
            } else {
                e
            }
        }),
    );
    cfg.set("metricsServer", JsValue::Object(metrics_server));

    // heartbeats
    let mut heartbeats = JsObject::new();
    heartbeats.set(
        "relayer",
        JsValue::Str(source.env(&["MORPHEUS_BETTERSTACK_RELAYER_HEARTBEAT_URL"])),
    );
    heartbeats.set(
        "feedRelayer",
        JsValue::Str(source.env(&["MORPHEUS_BETTERSTACK_RELAYER_FEED_HEARTBEAT_URL"])),
    );
    heartbeats.set(
        "failure",
        JsValue::Str(source.env(&["MORPHEUS_BETTERSTACK_RELAYER_FAILURE_URL"])),
    );
    heartbeats.set(
        "deadLetter",
        JsValue::Str(source.env(&["MORPHEUS_BETTERSTACK_RELAYER_DEADLETTER_URL"])),
    );
    cfg.set("heartbeats", JsValue::Object(heartbeats));

    Ok(cfg)
}

/// Number formatting helper the vectors use for interpolated numbers in gate
/// error strings (kept public for tests).
#[allow(dead_code)]
fn format_number_js(x: f64) -> String {
    number_to_string(x)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_from(pairs: &[(&str, &str)]) -> EnvSource {
        let mut process_env = JsObject::new();
        for (k, v) in pairs {
            process_env.set(*k, JsValue::Str((*v).to_string()));
        }
        EnvSource::new(process_env, JsObject::new())
    }

    fn reviewed_testnet_registry() -> JsValue {
        JsValue::from_json(crate::network_identity::known_network_registry("testnet").unwrap())
    }

    #[test]
    fn env_alias_order_is_precedence() {
        let source = env_from(&[("A", "second"), ("B", "first-wins")]);
        // First alias with a non-empty value wins, regardless of value content.
        assert_eq!(source.env(&["A", "B"]), "second");
        assert_eq!(source.env(&["MISSING", "B"]), "first-wins");
        // An empty-string alias falls through to the next one.
        let source = env_from(&[("A", "  "), ("B", "fallback")]);
        assert_eq!(source.env(&["A", "B"]), "fallback");
        assert_eq!(source.env(&["MISSING"]), "");
    }

    #[test]
    fn runtime_config_is_consulted_after_process_env() {
        let mut process_env = JsObject::new();
        process_env.set("A", JsValue::Str("direct".to_string()));
        let mut runtime = JsObject::new();
        runtime.set("A", JsValue::Number(42.0));
        runtime.set("B", JsValue::Bool(false));
        runtime.set("C", JsValue::Number(0.0));
        let source = EnvSource::new(process_env, runtime);
        assert_eq!(source.env(&["A"]), "direct");
        // Runtime config values stringify then trim: `false` is a value, 0 is a value.
        assert_eq!(source.env(&["A2", "B"]), "false");
        assert_eq!(source.env(&["C"]), "0");
        assert_eq!(source.env(&["MISSING"]), "");
    }

    #[test]
    fn parse_numeric_env_rejects_nan_but_keeps_finite() {
        assert_eq!(
            parse_numeric_env(&JsValue::Str("5000".to_string()), 250.0),
            5000.0
        );
        assert_eq!(
            parse_numeric_env(&JsValue::Str("abc".to_string()), 250.0),
            250.0,
            "mistyped value must fall back instead of becoming NaN"
        );
        assert_eq!(parse_numeric_env(&JsValue::Str("  ".to_string()), 7.0), 7.0);
        // Number() accepts exponent and radix forms.
        assert_eq!(
            parse_numeric_env(&JsValue::Str("0x10".to_string()), 0.0),
            16.0
        );
        assert_eq!(
            parse_numeric_env(&JsValue::Str("1e3".to_string()), 0.0),
            1000.0
        );
        // Infinity is finite? No — Number.isFinite(Infinity) is false → fallback.
        assert_eq!(
            parse_numeric_env(&JsValue::Str("1e999".to_string()), 99.0),
            99.0
        );
    }

    #[test]
    fn numeric_clamps_match_js_floors() {
        // retryMaxDelayMs clamps 1000..600000.
        let big = parse_numeric_env(&JsValue::Str("999999".to_string()), 10_000.0);
        let ceiling = big.min(MAX_RETRY_MAX_DELAY_MS);
        assert_eq!(ceiling.max(1000.0), 600_000.0);
        // Negative pollInterval parses (Number('-5') is finite) — the JS code
        // does NOT floor negatives for pollIntervalMs; only the parser fallback
        // protects, so -5 flows through unchanged.
        assert_eq!(
            parse_numeric_env(&JsValue::Str("-5".to_string()), 5000.0),
            -5.0
        );
    }

    #[test]
    fn parse_integer_string_passes_digits_through_verbatim() {
        assert_eq!(
            parse_integer_string(&JsValue::Str("0012".to_string()), "50"),
            "0012",
            "fixed8 amounts keep their literal string form"
        );
        assert_eq!(
            parse_integer_string(&JsValue::Str("12.5".to_string()), "50"),
            "50"
        );
        assert_eq!(
            parse_integer_string(&JsValue::Str("".to_string()), "50"),
            "50"
        );
    }

    #[test]
    fn rpc_ranking_puts_https_first_and_http_last() {
        let ranked = unique_ranked_rpc_urls(vec![
            "http://seed1.neo.org:10332".to_string(),
            "https://mainnet1.neo.coz.io:443".to_string(),
            "https://api.n3index.dev/mainnet".to_string(),
            "http://seed2.neo.org:10332".to_string(),
            "ftp://weird".to_string(),
        ]);
        // V8's Array#sort is stable, so equal-rank https entries keep input
        // order (coz.io precedes n3index.dev); ranks: https=0, other=1, http=2.
        assert_eq!(ranked[0], "https://mainnet1.neo.coz.io:443");
        assert_eq!(ranked[1], "https://api.n3index.dev/mainnet");
        assert_eq!(ranked[2], "ftp://weird");
        assert_eq!(ranked[3], "http://seed1.neo.org:10332");
        assert_eq!(
            ranked.last().map(String::as_str),
            Some("http://seed2.neo.org:10332"),
            "stable sort keeps equal-rank entries in original order"
        );
    }

    #[test]
    fn configured_rpc_resolution_rejects_cleartext_endpoints() {
        let error = require_https_rpc_urls(
            vec![
                "https://good.rpc".to_string(),
                "http://cleartext.rpc".to_string(),
            ],
            "Neo N3 testnet RPC",
        )
        .expect_err("cleartext RPC must be rejected");
        assert!(error
            .to_string()
            .contains("Neo N3 testnet RPC requires HTTPS RPC endpoints"));
    }

    #[test]
    fn relayer_config_rejects_an_explicit_cleartext_rpc_endpoint() {
        let source = env_from(&[
            ("MORPHEUS_NETWORK", "testnet"),
            ("NEO_TESTNET_RPC_URL", "http://cleartext.rpc"),
        ]);
        let error = derive_pure_fields(&source, &reviewed_testnet_registry(), "")
            .expect_err("a cleartext endpoint must stop config derivation");
        assert!(error
            .to_string()
            .contains("Neo N3 testnet RPC requires HTTPS RPC endpoints"));
    }

    #[test]
    fn parse_url_list_strips_one_trailing_slash() {
        let urls = parse_url_list(&JsValue::Str(" https://a.io/ ,https://b.io// ".to_string()));
        assert_eq!(urls, vec!["https://a.io", "https://b.io/"]);
    }

    #[test]
    fn parse_active_chains_falls_back_to_neo_n3() {
        assert_eq!(
            parse_active_chains(&JsValue::Str("neox, NEO_N3 ".to_string())),
            vec!["neox", "neo_n3"]
        );
        assert_eq!(
            parse_active_chains(&JsValue::Str("bogus".to_string())),
            vec!["neo_n3"]
        );
    }

    #[test]
    fn normalize_morpheus_network_accepts_only_reviewed_labels() {
        assert_eq!(
            normalize_morpheus_network(&JsValue::Str("MAINNET".to_string())),
            "mainnet"
        );
        assert_eq!(
            normalize_morpheus_network(&JsValue::Str("".to_string())),
            "testnet"
        );
        assert!(std::panic::catch_unwind(|| {
            normalize_morpheus_network(&JsValue::Str("test-net".to_string()))
        })
        .is_err());
    }

    #[test]
    fn derive_pure_fields_rejects_unknown_network_labels() {
        let source = env_from(&[("MORPHEUS_NETWORK", "staging")]);
        let error = derive_pure_fields(&source, &reviewed_testnet_registry(), "")
            .expect_err("an unknown network must not select TestNet");
        assert!(error.to_string().contains("unsupported Neo network"));
    }

    #[test]
    fn durable_queue_resolvers_flip_in_production() {
        assert!(!resolve_allow_local_claim_during_backoff(
            "production",
            true
        ));
        assert!(resolve_allow_local_claim_during_backoff(
            "development",
            true
        ));
        assert!(!resolve_allow_local_claim_during_backoff(
            "development",
            false
        ));
        assert!(resolve_durable_queue_fail_closed("production", false));
        assert!(!resolve_durable_queue_fail_closed("development", false));
    }

    #[test]
    fn network_magic_truthiness_chain() {
        let mut source = EnvSource::empty();
        assert!(resolve_neo_n3_network_magic("mainnet", &source, &JsValue::Undefined).is_nan());
        let mut registry = JsObject::new();
        let mut n3 = JsObject::new();
        n3.set("network_magic", JsValue::Number(0.0));
        registry.set("neo_n3", JsValue::Object(n3.clone()));
        // A missing or invalid registry is a configuration error, not a
        // reason to fall back to an embedded or caller-selected identity.
        assert!(resolve_neo_n3_network_magic(
            "testnet",
            &source,
            &JsValue::Object(registry.clone())
        )
        .is_nan());
        n3.set("network_magic", JsValue::Number(777.0));
        registry.set("neo_n3", JsValue::Object(n3));
        assert!(
            resolve_neo_n3_network_magic("testnet", &source, &JsValue::Object(registry)).is_nan()
        );
        let mut reviewed_n3 = JsObject::new();
        reviewed_n3.set("network_magic", JsValue::Number(894710606.0));
        let mut reviewed_registry = JsObject::new();
        reviewed_registry.set("neo_n3", JsValue::Object(reviewed_n3));
        assert_eq!(
            resolve_neo_n3_network_magic(
                "testnet",
                &source,
                &JsValue::Object(reviewed_registry.clone())
            ),
            894710606.0
        );
        // An explicit value is only a consistency assertion against the
        // reviewed registry; it cannot replace that identity.
        let mut process_env = JsObject::new();
        process_env.set("NEO_TESTNET_MAGIC", JsValue::Str("123".to_string()));
        source = EnvSource::new(process_env, JsObject::new());
        assert!(resolve_neo_n3_network_magic(
            "testnet",
            &source,
            &JsValue::Object(reviewed_registry)
        )
        .is_nan());
    }

    #[test]
    fn neox_chain_id_registry_is_authoritative() {
        let mut registry = JsObject::new();
        let mut neo_x = JsObject::new();
        neo_x.set("chain_id", JsValue::Number(12_227_332.0));
        registry.set("neo_x", JsValue::Object(neo_x));
        let matching = env_from(&[("NEOX_CHAIN_ID", "12227332")]);
        assert_eq!(
            resolve_neox_chain_id("testnet", &matching, &JsValue::Object(registry.clone()))
                .unwrap(),
            12_227_332.0
        );
        let conflicting = env_from(&[("NEOX_CHAIN_ID", "12227333")]);
        assert!(
            resolve_neox_chain_id("testnet", &conflicting, &JsValue::Object(registry)).is_err()
        );
        assert!(resolve_neox_chain_id("testnet", &matching, &JsValue::Undefined).is_err());
    }

    #[test]
    fn host_signer_detection_finds_wif_and_pk_shapes() {
        let source = env_from(&[
            ("MORPHEUS_WORKER_NEO_N3_WIF", "secret"),
            ("NEOX_UPDATER_PK", "pk"),
            ("UNRELATED", "x"),
        ]);
        let names = configured_host_signer_env_names(&source);
        assert_eq!(names, vec!["MORPHEUS_WORKER_NEO_N3_WIF", "NEOX_UPDATER_PK"]);
    }

    #[test]
    fn host_signer_gates_fire_with_exact_messages() {
        let source = env_from(&[("MORPHEUS_WORKER_NEO_N3_WIF", "secret")]);
        let err = derive_pure_fields(&source, &reviewed_testnet_registry(), "").unwrap_err();
        assert_eq!(
            err.to_string(),
            "host Neo N3 signing key configuration is forbidden in the relayer; use custody key ids instead (configured: MORPHEUS_WORKER_NEO_N3_WIF)"
        );
    }

    #[test]
    fn production_neox_lanes_are_configurable_without_host_keys() {
        let source = env_from(&[
            ("NODE_ENV", "production"),
            ("MORPHEUS_ACTIVE_CHAINS", "neox"),
        ]);
        derive_pure_fields(&source, &reviewed_testnet_registry(), "")
            .expect("the authoritative NeoX request lane is production-configurable");

        let feed_source = env_from(&[
            ("NODE_ENV", "production"),
            ("MORPHEUS_ACTIVE_CHAINS", "neox"),
            ("MORPHEUS_RELAYER_MODE", "feed_only"),
        ]);
        derive_pure_fields(&feed_source, &reviewed_testnet_registry(), "")
            .expect("the authoritative NeoX feed lane is production-configurable");
    }

    #[test]
    fn neox_custody_updater_key_is_chain_specific() {
        let source = env_from(&[
            ("SIGNER_ROLE_NEOX_UPDATER_KEY_ID", "neox-updater"),
            ("SIGNER_ROLE_UPDATER_KEY_ID", "n3-updater"),
        ]);
        let config = derive_pure_fields(&source, &reviewed_testnet_registry(), "")
            .expect("chain-specific custody ids should derive");
        let neox = config
            .get("neox")
            .and_then(JsValue::as_object)
            .expect("neox config");
        let neox_key_ids = neox
            .get("custodyKeyIds")
            .and_then(JsValue::as_object)
            .expect("neox custody key ids");
        assert_eq!(
            neox_key_ids.get("updater"),
            Some(&JsValue::Str("neox-updater".to_string()))
        );
        let n3 = config
            .get("neo_n3")
            .and_then(JsValue::as_object)
            .expect("Neo N3 config");
        let n3_key_ids = n3
            .get("custodyKeyIds")
            .and_then(JsValue::as_object)
            .expect("Neo N3 custody key ids");
        assert_eq!(
            n3_key_ids.get("updater"),
            Some(&JsValue::Str("n3-updater".to_string()))
        );
    }

    #[test]
    fn default_state_file_name_by_mode() {
        assert_eq!(
            default_state_file_name("combined"),
            ".morpheus-relayer-state.json"
        );
        assert_eq!(
            default_state_file_name("feed_only"),
            ".morpheus-relayer-state.feed_only.json"
        );
    }
}
