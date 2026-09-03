//! Pure slices of `workers/nitro-worker/src/platform/core.js`: the runtime
//! config + env resolution chain and the small coercion helpers the oracle
//! lane reads through (`trimString`, `normalizeBoolean`, `parseDurationMs`,
//! `strip0x`, `isHexString`).
//!
//! The JS module memoizes parsed runtime configs in module-level caches; this
//! port drops the caches — every function is a pure function of the injected
//! [`EnvReader`], so repeated calls re-derive the same value from the same env
//! snapshot and tests never mutate process state.

use serde_json::Value as Json;

use crate::js::{
    js_first_truthy, js_math_round, js_number, js_stringify, js_trim, js_trim_string, js_truthy,
};

/// Functions that read `process.env` in JS take one of these, so tests drive
/// every env branch without process mutation and the host can feed its overlay.
pub type EnvReader<'a> = &'a dyn Fn(&str) -> Option<String>;

/// `parseRuntimeConfigJson(raw)` (platform/core.js:43) — trim, empty → `{}`,
/// malformed JSON → `{}`.
pub fn parse_runtime_config_json(raw: &str) -> Json {
    let text = js_trim(raw);
    if text.is_empty() {
        return Json::Object(Default::default());
    }
    serde_json::from_str(text).unwrap_or(Json::Object(Default::default()))
}

/// `getRuntimeConfig()` (platform/core.js:28) — `MORPHEUS_RUNTIME_CONFIG_JSON`.
pub fn get_runtime_config(env: EnvReader<'_>) -> Json {
    let raw = env("MORPHEUS_RUNTIME_CONFIG_JSON").unwrap_or_default();
    parse_runtime_config_json(&raw)
}

/// `getRuntimeConfigForNetwork(network)` (platform/core.js:53) — the network
/// name normalized ('mainnet' or else 'testnet'), then the first non-empty of
/// `${UPPER}_RUNTIME_CONFIG_JSON` / `MORPHEUS_${UPPER}_RUNTIME_CONFIG_JSON`
/// parsed.
pub fn get_runtime_config_for_network(network: &str, env: EnvReader<'_>) -> Json {
    let normalized = if js_trim(network).to_lowercase() == "mainnet" {
        "mainnet"
    } else {
        "testnet"
    };
    let upper = normalized.to_uppercase();
    let scoped = env(&format!("{upper}_RUNTIME_CONFIG_JSON")).unwrap_or_default();
    let raw = if scoped.is_empty() {
        env(&format!("MORPHEUS_{upper}_RUNTIME_CONFIG_JSON")).unwrap_or_default()
    } else {
        scoped
    };
    parse_runtime_config_json(&raw)
}

/// `runtimeConfig[name] || ''` — a truthy config value is `String()`-coerced,
/// everything else (absent, `null`, `0`, `false`, `""`) collapses to empty.
fn config_string(config: &Json, name: &str) -> String {
    match config.get(name) {
        Some(value) if js_truthy(value) => js_stringify(value),
        _ => String::new(),
    }
}

/// One `process.env[NAME] || config[NAME] || ''` link: the raw env string wins
/// when non-empty (JS string truthiness), else the coerced config value.
fn env_or_config(env: EnvReader<'_>, name: &str, config: &Json) -> String {
    match env(name) {
        Some(raw) if !raw.is_empty() => raw,
        _ => config_string(config, name),
    }
}

/// `env(...names)` (platform/core.js:73) — the first name whose
/// `String(process.env[name] || runtimeConfig[name] || '').trim()` is
/// non-empty; the runtime config is `MORPHEUS_RUNTIME_CONFIG_JSON`.
pub fn read_env(env: EnvReader<'_>, names: &[&str]) -> String {
    let runtime_config = get_runtime_config(env);
    for name in names {
        let value = js_trim(&env_or_config(env, name, &runtime_config)).to_string();
        if !value.is_empty() {
            return value;
        }
    }
    String::new()
}

/// `envForNetwork(networkInput, ...names)` (platform/core.js:100) — per-name
/// resolution chain: `${name}_${UPPER}` env, the network-scoped runtime config,
/// the plain env name, the global runtime config; first trim-non-empty wins.
pub fn env_for_network(network_input: &str, names: &[&str], env: EnvReader<'_>) -> String {
    let network = normalize_morpheus_network(network_input, "testnet");
    let upper = network.to_uppercase();
    let scoped = get_runtime_config_for_network(&network, env);
    let global = get_runtime_config(env);
    for name in names {
        let raw = match env(&format!("{name}_{upper}")) {
            Some(raw) if !raw.is_empty() => raw,
            _ => match config_string(&scoped, name) {
                scoped_value if !scoped_value.is_empty() => scoped_value,
                _ => match env(name) {
                    Some(raw) if !raw.is_empty() => raw,
                    _ => config_string(&global, name),
                },
            },
        };
        let value = js_trim(&raw).to_string();
        if !value.is_empty() {
            return value;
        }
    }
    String::new()
}

/// `normalizeMorpheusNetwork(value, fallback)` (platform/core.js:82) —
/// 'mainnet'/'testnet' pass through, anything else resolves to the fallback
/// ('mainnet' or else 'testnet').
pub fn normalize_morpheus_network(value: &str, fallback: &str) -> String {
    let normalized = js_trim(value).to_lowercase();
    if normalized == "mainnet" || normalized == "testnet" {
        return normalized;
    }
    if fallback == "mainnet" {
        "mainnet".to_string()
    } else {
        "testnet".to_string()
    }
}

/// `resolvePayloadNetwork(payload, fallback)` (platform/core.js:90) — the
/// first truthy of network / morpheus_network / runtime_network / environment,
/// then normalized as a network name.
pub fn resolve_payload_network(payload: &Json, fallback: &str) -> String {
    let raw = js_first_truthy(
        payload,
        &[
            "network",
            "morpheus_network",
            "runtime_network",
            "environment",
        ],
    )
    .map(js_stringify)
    .unwrap_or_default();
    normalize_morpheus_network(&raw, fallback)
}

/// `normalizeBoolean(value, fallback)` (platform/core.js:171) — `undefined`,
/// `null` and `''` fall back; everything else is the lowercase-trimmed
/// `String(value)` compared against `1`/`true`/`yes`.
pub fn normalize_boolean(value: Option<&Json>, fallback: bool) -> bool {
    match value {
        None => fallback,
        Some(Json::Null) => fallback,
        Some(Json::String(s)) if s.is_empty() => fallback,
        Some(other) => {
            let normalized = js_trim(&js_stringify(other)).to_lowercase();
            normalized == "1" || normalized == "true" || normalized == "yes"
        }
    }
}

/// `parseDurationMs(value, fallbackMs)` (platform/core.js:267) — `undefined`,
/// `null` and `''` fall back; finite numbers truncate clamped ≥ 0; strings
/// lowercase-trim, then plain `^\d+$` millis or `^(\d+(?:\.\d+)?)(ms|s|m)$`
/// scaled with `Math.round`; anything else falls back. Values beyond `u64`
/// saturate (JS keeps them as doubles; both are "huge").
pub fn parse_duration_ms(value: Option<&Json>, fallback_ms: u64) -> u64 {
    match value {
        None | Some(Json::Null) => fallback_ms,
        Some(Json::String(s)) if s.is_empty() => fallback_ms,
        Some(Json::Number(n)) => match n.as_f64() {
            Some(f) if f.is_finite() => clamp_duration_ms(f.trunc()),
            // NaN/Infinity cannot exist inside serde_json numbers; the JS
            // string path they would take lands on the fallback anyway.
            _ => fallback_ms,
        },
        Some(other) => duration_ms_from_string(other, fallback_ms),
    }
}

fn clamp_duration_ms(ms: f64) -> u64 {
    if ms <= 0.0 {
        0
    } else {
        ms as u64 // saturating cast
    }
}

fn duration_ms_from_string(value: &Json, fallback_ms: u64) -> u64 {
    let raw = js_trim_string(Some(value)).to_lowercase();
    if raw.is_empty() {
        return fallback_ms;
    }
    if raw.bytes().all(|b| b.is_ascii_digit()) {
        return clamp_duration_ms(js_number(&raw));
    }
    let (amount, scale) = if let Some(rest) = raw.strip_suffix("ms") {
        (rest, 1.0)
    } else if let Some(rest) = raw.strip_suffix('s') {
        (rest, 1000.0)
    } else if let Some(rest) = raw.strip_suffix('m') {
        (rest, 60_000.0)
    } else {
        return fallback_ms;
    };
    if !is_duration_amount(amount) {
        return fallback_ms;
    }
    clamp_duration_ms(js_math_round(js_number(amount) * scale))
}

/// `^\d+(\.\d+)?$` — at least one integer digit, optional fraction with at
/// least one digit.
fn is_duration_amount(s: &str) -> bool {
    match s.split_once('.') {
        Some((whole, frac)) => {
            !whole.is_empty()
                && whole.bytes().all(|b| b.is_ascii_digit())
                && !frac.is_empty()
                && frac.bytes().all(|b| b.is_ascii_digit())
        }
        None => !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()),
    }
}

/// `strip0x(value)` (platform/core.js:219) — trimString with a case-insensitive
/// leading `0x` removed.
pub fn strip_0x(value: &str) -> String {
    let trimmed = js_trim(value);
    trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
        .unwrap_or(trimmed)
        .to_string()
}

/// `isHexString(value)` (platform/core.js:214) — non-empty even-length hex
/// after the optional `0x` prefix.
pub fn is_hex_string(value: &str) -> bool {
    let raw = strip_0x(value);
    !raw.is_empty() && raw.len().is_multiple_of(2) && raw.bytes().all(|b| b.is_ascii_hexdigit())
}

/// `Buffer.from(raw, 'base64')` — Node's decoder is lenient: characters
/// outside the alphabet are ignored and padding is optional. Malformed
/// trailing quanta (which Node decodes lossily) collapse to empty; real
/// payloads are well-formed.
pub fn buffer_from_base64(raw: &str) -> Vec<u8> {
    const STANDARD_ALPHABET: &str =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    use base64::engine::DecodePaddingMode;
    use base64::Engine as _;
    let filtered: String = raw
        .chars()
        .filter(|c| STANDARD_ALPHABET.contains(*c) || *c == '=')
        .collect();
    base64::engine::general_purpose::GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        base64::engine::general_purpose::GeneralPurposeConfig::new()
            .with_decode_padding_mode(DecodePaddingMode::Indifferent),
    )
    .decode(filtered.as_bytes())
    .unwrap_or_default()
}

/// `decodeBase64(value)` (platform/core.js:223) — base64url-tolerant: swap
/// `-`/`_` back to the standard alphabet, pad to a multiple of four, then
/// decode leniently.
pub fn decode_base64(value: &str) -> Vec<u8> {
    let normalized = js_trim(value).replace('-', "+").replace('_', "/");
    let rem = normalized.len() % 4;
    let padded = format!(
        "{normalized}{}",
        "=".repeat(if rem == 0 { 0 } else { 4 - rem })
    );
    buffer_from_base64(&padded)
}

/// `getSupabaseRestConfig()` (platform/core.js:124) — the encrypted-ref
/// resolution REST endpoint. `None` unless both a base URL and an API key
/// resolve; the REST URL strips exactly one trailing slash from the base.
pub struct SupabaseRestConfig {
    pub rest_url: String,
    pub api_key: String,
}

pub fn get_supabase_rest_config(env: EnvReader<'_>) -> Option<SupabaseRestConfig> {
    let base_url = read_env(
        env,
        &[
            "SUPABASE_URL",
            "NEXT_PUBLIC_SUPABASE_URL",
            "morpheus_SUPABASE_URL",
        ],
    );
    let api_key = read_env(
        env,
        &[
            "SUPABASE_SECRET_KEY",
            "morpheus_SUPABASE_SECRET_KEY",
            "SUPABASE_SERVICE_ROLE_KEY",
            "morpheus_SUPABASE_SERVICE_ROLE_KEY",
            "SUPABASE_SERVICE_KEY",
        ],
    );
    if base_url.is_empty() || api_key.is_empty() {
        return None;
    }
    Some(SupabaseRestConfig {
        rest_url: format!(
            "{}/rest/v1",
            base_url.strip_suffix('/').unwrap_or(&base_url)
        ),
        api_key,
    })
}

// --- Security: sanitize error messages before returning to caller (M-06) ---
// Blacklist approach: pass through unless the message matches a sensitive
// pattern (platform/core.js SENSITIVE_PATTERNS, ported without regex).

fn is_sensitive_error(message: &str) -> bool {
    let lowered = message.to_lowercase();
    // /private[_ ]?key/i, /secret[_ ]?key/i, /signing[_ ]?key/i,
    // /seed[_ ]?phrase/i — the optional separator collapses to three literal
    // spellings each.
    for stem in ["private", "secret", "signing"] {
        if lowered.contains(&format!("{stem}key"))
            || lowered.contains(&format!("{stem}_key"))
            || lowered.contains(&format!("{stem} key"))
        {
            return true;
        }
    }
    if lowered.contains("mnemonic") || lowered.contains("passphrase") {
        return true;
    }
    if lowered.contains("seedphrase")
        || lowered.contains("seed_phrase")
        || lowered.contains("seed phrase")
    {
        return true;
    }
    if lowered.contains("node_modules") || lowered.contains("/home/") {
        return true;
    }
    // /^\/(?:usr|etc|var|tmp)\//m
    if message.lines().any(|line| {
        line.starts_with("/usr/")
            || line.starts_with("/etc/")
            || line.starts_with("/var/")
            || line.starts_with("/tmp/")
    }) {
        return true;
    }
    // /\.js:\d+:\d+/
    if let Some(index) = message.find(".js:") {
        let rest = &message[index + 4..];
        if let Some((line, after)) = rest.split_once(':') {
            let line_ok = !line.is_empty() && line.bytes().all(|b| b.is_ascii_digit());
            let column_digits = after
                .find(|c: char| !c.is_ascii_digit())
                .unwrap_or(after.len());
            if line_ok && column_digits > 0 {
                return true;
            }
        }
    }
    // /^Error:\s*0x[0-9a-f]{20,}/im and /^Error:\s*[0-9a-f]{64}\b/im
    for line in message.lines() {
        let Some(rest) = line.strip_prefix("Error:") else {
            continue;
        };
        let rest = rest.trim_start_matches(|c: char| c.is_whitespace());
        if let Some(hex) = rest.strip_prefix("0x") {
            let hex_chars = hex
                .find(|c: char| !c.is_ascii_hexdigit())
                .unwrap_or(hex.len());
            if hex_chars >= 20 {
                return true;
            }
        }
        let hex_chars = rest
            .find(|c: char| !c.is_ascii_hexdigit())
            .unwrap_or(rest.len());
        if hex_chars == 64 {
            // \b — the 64-hex run must not continue into another word char
            let next = rest[64..].chars().next();
            if !next.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_') {
                return true;
            }
        }
    }
    // /wif\b.*\bKx?\w{30,}/i — a standalone "wif" followed later by a
    // boundary-anchored K/Kx + 30+ word characters. All offsets live inside the
    // lowercased string so boundaries stay byte-consistent.
    let lowered_bytes = lowered.as_bytes();
    let is_word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let mut search_from = 0;
    while let Some(relative) = lowered[search_from..].find("wif") {
        let start = search_from + relative;
        let end = start + 3;
        let standalone = (start == 0 || !is_word(lowered_bytes[start - 1]))
            && (end >= lowered_bytes.len() || !is_word(lowered_bytes[end]));
        if standalone {
            let mut cursor = end;
            while let Some(k) = lowered[cursor..].find('k') {
                let at = cursor + k;
                let at_boundary = at == 0 || !is_word(lowered_bytes[at - 1]);
                if at_boundary {
                    let after_x = if lowered[at + 1..].starts_with('x') {
                        at + 2
                    } else {
                        at + 1
                    };
                    let word_chars = lowered[after_x..]
                        .find(|c: char| !c.is_ascii_alphanumeric() && c != '_')
                        .unwrap_or(lowered.len() - after_x);
                    if word_chars >= 30 {
                        return true;
                    }
                }
                cursor = at + 1;
            }
        }
        search_from = end;
    }
    false
}

/// `sanitizeErrorMessage(error)` (platform/core.js:358) — pass the message
/// through unless it matches a sensitive pattern, then cap at 200 characters.
/// (The cap counts `char`s; JS counts UTF-16 code units — they differ only for
/// astral-plane characters.)
pub fn sanitize_error_message(message: &str) -> String {
    if is_sensitive_error(message) {
        return "internal error".to_string();
    }
    message.chars().take(200).collect()
}

/// `resolveMaxBytes(value, fallbackBytes, minBytes)` (platform/core.js:181) —
/// blank or non-finite input takes the larger of the fallback and the floor;
/// everything else truncates and is floored at `minBytes`.
pub fn resolve_max_bytes(value: Option<&Json>, fallback_bytes: u64, min_bytes: u64) -> u64 {
    let blank = match value {
        None | Some(Json::Null) => true,
        Some(raw) => crate::js::js_trim_string(Some(raw)).is_empty(),
    };
    if blank {
        return fallback_bytes.max(min_bytes);
    }
    let numeric = crate::js::js_to_number(value.unwrap_or(&Json::Null));
    if !numeric.is_finite() {
        return fallback_bytes.max(min_bytes);
    }
    let floored = numeric.trunc().max(min_bytes as f64);
    if floored >= u64::MAX as f64 {
        u64::MAX
    } else {
        floored as u64
    }
}

/// `cappedDurationMs(value, fallbackMs, maxMs)` (platform/core.js:286) — the
/// M-10 cap over `parseDurationMs`.
pub fn capped_duration_ms(value: Option<&Json>, fallback_ms: u64, max_ms: u64) -> u64 {
    parse_duration_ms(value, fallback_ms).min(max_ms)
}

/// `measureSerializedSizeBytes(value)` (platform/core.js:190) — UTF-8 byte
/// length of the stable JSON serialization.
pub fn measure_serialized_size_bytes(value: &Json) -> usize {
    crate::stable_stringify::stable_stringify(value).len()
}

/// `enforceSerializedSizeLimit(value, label, maxBytes)` (platform/core.js:194)
/// — JS throws `Error`; lane ports surface it as `Err(String)`.
pub fn enforce_serialized_size_limit(
    value: &Json,
    label: &str,
    max_bytes: u64,
) -> Result<usize, String> {
    let size = measure_serialized_size_bytes(value);
    if size as u64 > max_bytes {
        return Err(format!("{label} exceeds max size of {max_bytes} bytes"));
    }
    Ok(size)
}

/// The subset of the WHATWG `Headers` object the oracle lane uses: names are
/// stored lowercased (`Headers.set` normalizes), `set` upserts in place
/// (keeping the first insertion position), and `get` is case-insensitive.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct JsHeaders {
    entries: Vec<(String, String)>,
}

impl JsHeaders {
    /// `normalizeHeaders(input)` (platform/core.js:235) — only string values
    /// are copied; non-objects produce empty headers.
    pub fn normalize(input: &Json) -> JsHeaders {
        let mut headers = JsHeaders::default();
        if let Json::Object(map) = input {
            for (key, value) in map {
                if let Json::String(text) = value {
                    headers.set(key, text);
                }
            }
        }
        headers
    }

    /// `Headers.set(name, value)` — lowercase the name, overwrite an existing
    /// entry in place.
    pub fn set(&mut self, name: &str, value: &str) {
        let lowered = name.to_lowercase();
        for (existing_name, existing_value) in &mut self.entries {
            if *existing_name == lowered {
                *existing_value = value.to_string();
                return;
            }
        }
        self.entries.push((lowered, value.to_string()));
    }

    /// `Headers.get(name)` — case-insensitive.
    pub fn get(&self, name: &str) -> Option<&str> {
        self.entries
            .iter()
            .find(|(existing_name, _)| *existing_name == name.to_lowercase())
            .map(|(_, value)| value.as_str())
    }

    pub fn entries(&self) -> &[(String, String)] {
        &self.entries
    }

    /// `Object.fromEntries(headers.entries())` — later duplicates overwrite
    /// while keeping the first position; the stored entries are already
    /// unique per name.
    pub fn to_object(&self) -> Json {
        let mut map = serde_json::Map::new();
        for (name, value) in &self.entries {
            map.insert(name.clone(), Json::String(value.clone()));
        }
        Json::Object(map)
    }
}

/// `parseBodyMaybe(raw, contentType)` (platform/core.js:244) — parse only when
/// the content type names JSON or the trimmed body opens like JSON.
pub fn parse_body_maybe(raw: &str, content_type: Option<&str>) -> Option<Json> {
    if raw.is_empty() {
        return None;
    }
    let looks_json = content_type.unwrap_or("").contains("application/json")
        || raw.trim_start().starts_with('[')
        || raw.trim_start().starts_with('{');
    if !looks_json {
        return None;
    }
    serde_json::from_str(raw).ok()
}

/// `getJsonPathValue(value, path)` (platform/core.js:256) — dot segments over
/// plain objects and arrays. The walk mirrors the JS reduce exactly: a falsy
/// or non-object intermediate yields undefined, a missing member yields
/// undefined, and `arr["length"]` really does return the array length.
pub fn get_json_path_value(value: &Json, path: &Json) -> Option<Json> {
    if !crate::js::js_truthy(path) {
        return None;
    }
    if !matches!(value, Json::Object(_) | Json::Array(_)) {
        return None;
    }
    let mut current: Option<Json> = Some(value.clone());
    for segment in crate::js::js_stringify(path)
        .split('.')
        .filter(|s| !s.is_empty())
    {
        let node = match current {
            Some(ref node) if matches!(node, Json::Object(_) | Json::Array(_)) => node,
            _ => return None,
        };
        current = match node {
            Json::Object(map) => map.get(segment).cloned(),
            Json::Array(items) => {
                if segment == "length" {
                    Some(Json::Number(items.len().into()))
                } else {
                    // array["01"] is undefined in JS — only canonical decimal
                    // indices name an element.
                    let canonical = segment != "0" && segment.starts_with('0');
                    if canonical {
                        None
                    } else {
                        segment
                            .parse::<usize>()
                            .ok()
                            .and_then(|index| items.get(index).cloned())
                    }
                }
            }
            _ => None,
        };
    }
    current
}

/// `normalizeTargetChain(value)` (platform/core.js:229).
pub fn normalize_target_chain(value: &Json) -> Result<String, String> {
    let chosen = if crate::js::js_truthy(value) {
        value
    } else {
        &Json::String("neo_n3".to_string())
    };
    let normalized = crate::js::js_trim_string(Some(chosen)).to_lowercase();
    if normalized == "neo_n3" || normalized == "neox" {
        Ok(normalized)
    } else {
        Err(format!(
            "unsupported target_chain: {}",
            crate::js::js_stringify(value)
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    fn env_from(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |name| map.get(name).cloned()
    }

    #[test]
    fn runtime_config_parsing_is_trim_and_error_tolerant() {
        assert_eq!(parse_runtime_config_json(""), json!({}));
        assert_eq!(parse_runtime_config_json("   "), json!({}));
        assert_eq!(parse_runtime_config_json("{ not json"), json!({}));
        assert_eq!(
            parse_runtime_config_json("  {\"SUPABASE_URL\":\"u\"}  "),
            json!({ "SUPABASE_URL": "u" })
        );
    }

    #[test]
    fn runtime_config_reads_the_global_key() {
        let env = env_from(&[("MORPHEUS_RUNTIME_CONFIG_JSON", "{\"A\":\"1\"}")]);
        assert_eq!(get_runtime_config(&env), json!({ "A": "1" }));
        let empty = env_from(&[]);
        assert_eq!(get_runtime_config(&empty), json!({}));
    }

    #[test]
    fn runtime_config_for_network_prefers_the_scoped_key() {
        let env = env_from(&[
            ("MAINNET_RUNTIME_CONFIG_JSON", "{\"A\":\"scoped\"}"),
            (
                "MORPHEUS_MAINNET_RUNTIME_CONFIG_JSON",
                "{\"A\":\"prefixed\"}",
            ),
        ]);
        assert_eq!(
            get_runtime_config_for_network("Mainnet", &env),
            json!({ "A": "scoped" })
        );

        let prefixed = env_from(&[("MORPHEUS_TESTNET_RUNTIME_CONFIG_JSON", "{\"B\":\"2\"}")]);
        assert_eq!(
            get_runtime_config_for_network("testnet", &prefixed),
            json!({ "B": "2" })
        );
        // anything but 'mainnet' normalizes to testnet
        assert_eq!(
            get_runtime_config_for_network("whatever", &prefixed),
            json!({ "B": "2" })
        );
    }

    #[test]
    fn env_resolves_through_the_global_runtime_config() {
        let env = env_from(&[(
            "MORPHEUS_RUNTIME_CONFIG_JSON",
            "{\"SUPABASE_URL\":\"u\",\"EMPTY\":\"\",\"ZERO\":0,\"N\":42}",
        )]);
        assert_eq!(read_env(&env, &["SUPABASE_URL"]), "u");
        assert_eq!(read_env(&env, &["N"]), "42"); // String(number) coercion
        assert_eq!(read_env(&env, &["EMPTY", "N"]), "42"); // falsy config skipped
        assert_eq!(read_env(&env, &["ZERO", "N"]), "42");
        assert_eq!(read_env(&env, &["MISSING"]), "");
    }

    #[test]
    fn env_prefers_process_env_and_trims_the_result() {
        let env = env_from(&[
            (
                "MORPHEUS_RUNTIME_CONFIG_JSON",
                "{\"A\":\"from-config\",\"B\":\"from-config\"}",
            ),
            ("A", " from-env "),
            // a whitespace env value is TRUTHY in JS — it wins the || chain
            // and trims to "", so the config is never consulted for that name
            ("B", "   "),
        ]);
        assert_eq!(read_env(&env, &["A"]), "from-env");
        assert_eq!(read_env(&env, &["B"]), "");
        assert_eq!(read_env(&env, &["B", "A"]), "from-env"); // next name is consulted
    }

    #[test]
    fn env_for_network_walks_the_four_way_chain() {
        // plain env beats the global config (no scoped entry present)
        let env = env_from(&[
            ("MORPHEUS_RUNTIME_CONFIG_JSON", "{\"K\":\"global-config\"}"),
            ("K", "plain-env"),
        ]);
        assert_eq!(env_for_network("mainnet", &["K"], &env), "plain-env");

        // scoped env beats everything
        let env2 = env_from(&[
            ("MORPHEUS_RUNTIME_CONFIG_JSON", "{\"K\":\"global-config\"}"),
            ("K_MAINNET", "scoped-env"),
            ("K", "plain-env"),
        ]);
        assert_eq!(env_for_network("mainnet", &["K"], &env2), "scoped-env");

        // scoped config beats plain env (it sits earlier in the JS chain)
        let env3 = env_from(&[
            (
                "MORPHEUS_MAINNET_RUNTIME_CONFIG_JSON",
                "{\"K\":\"scoped-config\"}",
            ),
            ("K", "plain-env"),
        ]);
        assert_eq!(env_for_network("mainnet", &["K"], &env3), "scoped-config");

        // testnet ignores mainnet-scoped entries
        let env4 = env_from(&[(
            "MORPHEUS_MAINNET_RUNTIME_CONFIG_JSON",
            "{\"K\":\"scoped-config\"}",
        )]);
        assert_eq!(env_for_network("testnet", &["K"], &env4), "");
    }

    #[test]
    fn network_normalization_follows_the_js_rules() {
        assert_eq!(normalize_morpheus_network("Mainnet ", "testnet"), "mainnet");
        assert_eq!(normalize_morpheus_network("", "testnet"), "testnet");
        assert_eq!(normalize_morpheus_network("xyz", "testnet"), "testnet");
        assert_eq!(normalize_morpheus_network("xyz", "mainnet"), "mainnet");
        assert_eq!(normalize_morpheus_network("TESTNET", "mainnet"), "testnet");
    }

    #[test]
    fn payload_network_uses_the_first_truthy_key() {
        assert_eq!(
            resolve_payload_network(&json!({ "network": "mainnet" }), "testnet"),
            "mainnet"
        );
        assert_eq!(
            resolve_payload_network(
                &json!({ "network": null, "morpheus_network": "mainnet" }),
                "testnet"
            ),
            "mainnet"
        );
        assert_eq!(
            resolve_payload_network(&json!({ "runtime_network": "testnet" }), "mainnet"),
            "testnet"
        );
        assert_eq!(
            resolve_payload_network(&json!({ "environment": "production" }), "testnet"),
            "testnet" // not a network name → fallback
        );
        assert_eq!(
            resolve_payload_network(&json!({ "network": 5 }), "testnet"),
            "testnet" // String(5) = "5" is not a network name
        );
        assert_eq!(resolve_payload_network(&json!({}), "mainnet"), "mainnet");
    }

    #[test]
    fn boolean_normalization_matches_the_js_gates() {
        assert!(!normalize_boolean(None, false));
        assert!(normalize_boolean(None, true));
        assert!(normalize_boolean(Some(&Json::Null), true));
        assert!(normalize_boolean(Some(&json!("")), true));
        assert!(normalize_boolean(Some(&json!("1")), false));
        assert!(normalize_boolean(Some(&json!("true")), false));
        assert!(normalize_boolean(Some(&json!("yes")), false));
        assert!(normalize_boolean(Some(&json!("  TRUE  ")), false));
        assert!(normalize_boolean(Some(&json!(true)), false));
        assert!(normalize_boolean(Some(&json!(1)), false)); // String(1) = "1"
        assert!(!normalize_boolean(Some(&json!("0")), true));
        assert!(!normalize_boolean(Some(&json!(0)), true)); // "0" is not 1/true/yes
        assert!(!normalize_boolean(Some(&json!("   ")), true)); // trims empty → false, not fallback
    }

    #[test]
    fn duration_parsing_covers_every_branch() {
        let none: Option<&Json> = None;
        assert_eq!(parse_duration_ms(none, 7), 7);
        assert_eq!(parse_duration_ms(Some(&Json::Null), 7), 7);
        assert_eq!(parse_duration_ms(Some(&json!("")), 7), 7);
        assert_eq!(parse_duration_ms(Some(&json!(0)), 7), 0);
        assert_eq!(parse_duration_ms(Some(&json!(1500.9)), 7), 1500); // trunc
        assert_eq!(parse_duration_ms(Some(&json!("100")), 7), 100);
        assert_eq!(parse_duration_ms(Some(&json!("1.5s")), 7), 1500);
        assert_eq!(parse_duration_ms(Some(&json!("2m")), 7), 120000);
        assert_eq!(parse_duration_ms(Some(&json!("750ms")), 7), 750);
        assert_eq!(parse_duration_ms(Some(&json!("10S")), 7), 10000); // lowercased first
        assert_eq!(parse_duration_ms(Some(&json!("1.5ms")), 7), 2); // Math.round half-up
        assert_eq!(parse_duration_ms(Some(&json!("1.5m")), 7), 90000);
        assert_eq!(parse_duration_ms(Some(&json!("abc")), 7), 7);
        assert_eq!(parse_duration_ms(Some(&json!("1.5")), 7), 7); // no unit → fallback
        assert_eq!(parse_duration_ms(Some(&json!("-5")), 7), 7);
        assert_eq!(parse_duration_ms(Some(&json!("1.5x")), 7), 7);
        assert_eq!(parse_duration_ms(Some(&json!("   ")), 7), 7);
        assert_eq!(parse_duration_ms(Some(&json!(true)), 7), 7); // "true" → fallback
        assert_eq!(parse_duration_ms(Some(&json!(" 500 ")), 7), 500);
    }

    #[test]
    fn hex_helpers_match_the_js_guards() {
        assert_eq!(strip_0x("0xAbCd"), "AbCd");
        assert_eq!(strip_0x("0Xab"), "ab");
        assert_eq!(strip_0x(" ab "), "ab");
        assert_eq!(strip_0x(""), "");
        assert_eq!(strip_0x("0x"), "");
        assert!(is_hex_string("0xabcd"));
        assert!(is_hex_string("ABCD"));
        assert!(!is_hex_string("abc")); // odd length
        assert!(!is_hex_string("0xzz"));
        assert!(!is_hex_string(""));
        assert!(!is_hex_string("0x"));
    }

    #[test]
    fn supabase_rest_config_resolves_the_alias_chain() {
        let config = get_supabase_rest_config(&env_from(&[
            ("SUPABASE_URL", "https://sb.example"),
            ("SUPABASE_SECRET_KEY", "sk_test"),
        ]))
        .expect("resolves");
        assert_eq!(config.rest_url, "https://sb.example/rest/v1");
        assert_eq!(config.api_key, "sk_test");

        // exactly one trailing slash is stripped from the base
        let config = get_supabase_rest_config(&env_from(&[
            ("SUPABASE_URL", "https://sb.example/"),
            ("SUPABASE_SECRET_KEY", "sk"),
        ]))
        .unwrap();
        assert_eq!(config.rest_url, "https://sb.example/rest/v1");

        // base aliases in order; key aliases in order
        let config = get_supabase_rest_config(&env_from(&[
            ("NEXT_PUBLIC_SUPABASE_URL", "https://next.example"),
            ("SUPABASE_SERVICE_ROLE_KEY", "service-role"),
        ]))
        .unwrap();
        assert_eq!(config.rest_url, "https://next.example/rest/v1");
        assert_eq!(config.api_key, "service-role");

        let config = get_supabase_rest_config(&env_from(&[
            ("morpheus_SUPABASE_URL", "https://morpheus.example"),
            ("morpheus_SUPABASE_SECRET_KEY", "m-secret"),
        ]))
        .unwrap();
        assert_eq!(config.rest_url, "https://morpheus.example/rest/v1");
        assert_eq!(config.api_key, "m-secret");

        let config = get_supabase_rest_config(&env_from(&[
            ("SUPABASE_URL", "https://sb.example"),
            ("SUPABASE_SERVICE_KEY", "service"),
        ]))
        .unwrap();
        assert_eq!(config.api_key, "service");

        // missing either half → None
        assert!(
            get_supabase_rest_config(&env_from(&[("SUPABASE_URL", "https://sb.example")]))
                .is_none()
        );
        assert!(get_supabase_rest_config(&env_from(&[("SUPABASE_SECRET_KEY", "sk")])).is_none());
        assert!(get_supabase_rest_config(&env_from(&[])).is_none());
    }

    #[test]
    fn sanitize_error_message_redacts_sensitive_patterns() {
        let sensitive: Vec<String> = vec![
            "the private key is unreachable".to_string(),
            "private_key not configured".to_string(),
            "secretkey missing".to_string(),
            "signing key unavailable".to_string(),
            "mnemonic required".to_string(),
            "bad passphrase".to_string(),
            "seed phrase lost".to_string(),
            "seed_phrase file not found".to_string(),
            "cannot read node_modules/ethers/index.js".to_string(),
            "ENOENT: no such file or directory, open '/home/user/.env'".to_string(),
            "/etc/passwd: permission denied".to_string(),
            "at Object.<anonymous> (worker.js:12:34)".to_string(),
            "Error: 0xabcdef0123456789abcdef0123456789abcdef01".to_string(),
            format!("Error: {}", "a".repeat(64)),
            format!("wif Kx{}", "9f86d6a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5"),
        ];
        for message in &sensitive {
            assert_eq!(
                sanitize_error_message(message),
                "internal error",
                "expected redaction for: {message}"
            );
        }
    }

    #[test]
    fn sanitize_error_message_passes_benign_messages_and_caps_length() {
        assert_eq!(
            sanitize_error_message("twelvedata upstream returned HTTP 429"),
            "twelvedata upstream returned HTTP 429"
        );
        let long = "x".repeat(500);
        assert_eq!(sanitize_error_message(&long), "x".repeat(200));
        // near-boundary hex: 19 hex digits after Error: 0x stays benign
        assert_eq!(
            sanitize_error_message(&format!("Error: 0x{}", "a".repeat(19))),
            format!("Error: 0x{}", "a".repeat(19))
        );
        // 63 hex digits (not 64) after Error: stays benign
        assert_eq!(
            sanitize_error_message(&format!("Error: {}", "b".repeat(63))),
            format!("Error: {}", "b".repeat(63))
        );
    }

    #[test]
    fn resolve_max_bytes_floors_and_falls_back_like_the_js() {
        // blank/missing/non-finite → the larger of fallback and min
        assert_eq!(resolve_max_bytes(None, 262_144, 4_096), 262_144);
        assert_eq!(resolve_max_bytes(Some(&Json::Null), 0, 4_096), 4_096);
        assert_eq!(resolve_max_bytes(Some(&json!("   ")), 0, 4_096), 4_096);
        assert_eq!(resolve_max_bytes(Some(&json!("abc")), 256, 4_096), 4_096);
        // numbers truncate and floor; negatives land on the floor
        assert_eq!(resolve_max_bytes(Some(&json!(300_000)), 0, 4_096), 300_000);
        assert_eq!(resolve_max_bytes(Some(&json!("100.9")), 0, 4_096), 4_096);
        assert_eq!(resolve_max_bytes(Some(&json!(0)), 0, 4_096), 4_096);
        assert_eq!(resolve_max_bytes(Some(&json!(-5)), 0, 4_096), 4_096);
        assert_eq!(resolve_max_bytes(Some(&json!(true)), 0, 4_096), 4_096);
        assert_eq!(resolve_max_bytes(Some(&json!("2048")), 0, 4_096), 4_096);
    }

    #[test]
    fn capped_duration_ms_caps_user_durations() {
        assert_eq!(capped_duration_ms(None, 8_000, 10_000), 8_000);
        assert_eq!(
            capped_duration_ms(Some(&json!("15000")), 8_000, 10_000),
            10_000
        );
        assert_eq!(capped_duration_ms(Some(&json!("2s")), 8_000, 10_000), 2_000);
        assert_eq!(
            capped_duration_ms(Some(&json!("1m")), 8_000, 10_000),
            10_000
        );
        assert_eq!(capped_duration_ms(Some(&json!(0)), 8_000, 10_000), 0);
    }

    #[test]
    fn js_headers_normalize_set_and_render_like_the_whatwg_object() {
        let input = json!({
            "Authorization": "tok",
            "x-a": 1,
            "X-A": "second",
            "b": "v",
        });
        let headers = JsHeaders::normalize(&input);
        // only string values copy; names lowercase; x-a overwritten in place
        assert_eq!(
            headers.entries(),
            &[
                ("authorization".to_string(), "tok".to_string()),
                ("x-a".to_string(), "second".to_string()),
                ("b".to_string(), "v".to_string()),
            ]
        );
        assert_eq!(headers.get("AUTHORIZATION"), Some("tok"));
        assert_eq!(headers.get("missing"), None);
        assert_eq!(
            headers.to_object(),
            json!({ "authorization": "tok", "x-a": "second", "b": "v" })
        );
        // non-objects produce empty headers
        assert_eq!(JsHeaders::normalize(&json!([1, 2])), JsHeaders::default());
        assert_eq!(JsHeaders::normalize(&Json::Null), JsHeaders::default());
    }

    #[test]
    fn parse_body_maybe_requires_a_json_shape() {
        assert_eq!(parse_body_maybe("{\"a\":1}", None), Some(json!({"a": 1})));
        assert_eq!(
            parse_body_maybe("[1,2]", Some("text/plain")),
            Some(json!([1, 2]))
        );
        assert_eq!(
            parse_body_maybe("plain", Some("application/json")),
            None // parse failure → null
        );
        assert_eq!(parse_body_maybe("", Some("application/json")), None);
        assert_eq!(parse_body_maybe("plain", None), None);
        assert_eq!(parse_body_maybe("  {\"a\":1}", None), Some(json!({"a": 1})));
    }

    #[test]
    fn json_path_walks_like_the_js_reduce() {
        let value = json!({
            "a": { "b": [1, 2, { "c": "v" }] },
            "zero": 0,
            "empty": "",
        });
        assert_eq!(
            get_json_path_value(&value, &json!("a.b.2.c")),
            Some(json!("v"))
        );
        // a falsy FINAL value is still returned (only intermediates stop the walk)
        assert_eq!(get_json_path_value(&value, &json!("zero")), Some(json!(0)));
        assert_eq!(
            get_json_path_value(&value, &json!("empty")),
            Some(json!(""))
        );
        // missing members, non-object intermediates, and falsy paths are undefined
        assert_eq!(get_json_path_value(&value, &json!("a.b.9.c")), None);
        assert_eq!(get_json_path_value(&value, &json!("zero.x")), None);
        assert_eq!(get_json_path_value(&value, &Json::Null), None);
        assert_eq!(get_json_path_value(&value, &json!("")), None);
        assert_eq!(get_json_path_value(&value, &json!(0)), None);
        assert_eq!(get_json_path_value(&json!("scalar"), &json!("a")), None);
        // empty segments are filtered out; arrays index canonically
        assert_eq!(get_json_path_value(&value, &json!("a.b.0")), Some(json!(1)));
        assert_eq!(
            get_json_path_value(&value, &json!(".a..b.1")),
            Some(json!(2))
        );
        assert_eq!(get_json_path_value(&json!([1, 2]), &json!("01")), None);
        assert_eq!(
            get_json_path_value(&json!([1, 2]), &json!("length")),
            Some(json!(2))
        );
    }

    #[test]
    fn target_chains_normalize_to_the_supported_set() {
        assert_eq!(normalize_target_chain(&json!("NeoX ")).unwrap(), "neox");
        assert_eq!(normalize_target_chain(&json!("neo_n3")).unwrap(), "neo_n3");
        assert_eq!(normalize_target_chain(&Json::Null).unwrap(), "neo_n3");
        assert_eq!(normalize_target_chain(&json!("")).unwrap(), "neo_n3");
        assert_eq!(
            normalize_target_chain(&json!("mainnet")).unwrap_err(),
            "unsupported target_chain: mainnet"
        );
        assert_eq!(
            normalize_target_chain(&json!(123)).unwrap_err(),
            "unsupported target_chain: 123"
        );
    }
}
