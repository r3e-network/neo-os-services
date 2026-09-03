//! `parseAllowNet` + the child-process permission-model gate — the port of
//! `platform/permission-guard.js`.
//!
//! The security posture carries over verbatim:
//!
//! * The network allowlist for sandboxed child processes accepts specific
//!   hostnames/addresses (optional port) and rejects wildcards, CIDRs and
//!   partial-wildcard patterns — `parse_allow_net` reports invalid entries,
//!   `validate_child_process_permissions` fails boot on any of them.
//! * The permission model is ENABLED BY DEFAULT. Only the deliberately
//!   long-named dev override `MORPHEUS_ALLOW_UNSANDBOXED_CHILDREN`
//!   (=1/true/yes) can disable it, and under `NODE_ENV=production` the
//!   override is IGNORED — fail closed. The retired
//!   `SCRIPT_CHILD_ENABLE_PERMISSION_MODEL` toggle has no effect.
//!
//! Env access is injected like everywhere in this crate; `NODE_ENV` equality
//! is exact (no trim/lowercase) exactly as the JS `===` is.

pub type EnvReader<'a> = &'a dyn Fn(&str) -> Option<String>;

pub const UNSANDBOXED_CHILDREN_OVERRIDE_VAR: &str = "MORPHEUS_ALLOW_UNSANDBOXED_CHILDREN";
pub const DEFAULT_ALLOW_NET_VAR: &str = "SCRIPT_CHILD_ALLOW_NET";

/// `parseAllowNet` — comma-split, trimmed, empty entries dropped; returns
/// `(entries, invalid)` with invalid entries in input order.
pub fn parse_allow_net(raw: &str) -> (Vec<String>, Vec<String>) {
    let entries: Vec<String> = crate::js::js_trim(raw)
        .split(',')
        .map(|entry| entry.trim().to_string())
        .filter(|entry| !entry.is_empty())
        .collect();

    let mut invalid = Vec::new();
    for entry in &entries {
        if entry == "*"
            || entry == "0.0.0.0/0"
            || entry == "::/0"
            || entry.starts_with("*.")
            || !is_valid_allow_net_entry(entry)
        {
            invalid.push(entry.clone());
        }
    }
    (entries, invalid)
}

/// `isValidAllowNetEntry` — hostname (optional port) or IPv4/bracketed-IPv6
/// (optional port); bare CIDRs, wildcards and empty segments rejected.
fn is_valid_allow_net_entry(entry: &str) -> bool {
    if entry.is_empty() || entry.contains(' ') {
        return false;
    }
    // Strip an optional trailing port: /:\d+$/ (≥ 1 digit).
    let host = strip_trailing_port(entry);
    if host.is_empty() {
        return false;
    }
    if host.contains('/') || host.contains('*') {
        return false;
    }
    if let Some(octets) = ipv4_octets(host) {
        return octets.iter().all(|octet| *octet <= 255);
    }
    // Bracketed IPv6: accepted as-is ("deeper validation is overkill here").
    if host.starts_with('[') && host.ends_with(']') {
        return true;
    }
    // Unbracketed IPv6-like: Node --allow-net accepts it, the guard prefers
    // brackets.
    if host.contains(':') && !host.starts_with('[') {
        return false;
    }
    host.split('.').all(is_valid_hostname_label)
}

/// `entry.replace(/:\d+$/, '')` — a trailing `:` + digit run. Operates on
/// bytes: every byte the regex can match is ASCII, so slicing stays on
/// char boundaries.
fn strip_trailing_port(entry: &str) -> &str {
    let bytes = entry.as_bytes();
    let Some(&last) = bytes.last() else {
        return entry;
    };
    if !last.is_ascii_digit() {
        return entry;
    }
    let mut end = bytes.len();
    while end > 0 && bytes[end - 1].is_ascii_digit() {
        end -= 1;
    }
    if end > 0 && bytes[end - 1] == b':' {
        &entry[..end - 1]
    } else {
        entry
    }
}

/// The IPv4 literal branch: exactly four 1-3 digit groups (`^(\d{1,3})\.(…)$`).
/// Leading zeros are fine — the JS tests `Number(octet) <= 255`.
fn ipv4_octets(host: &str) -> Option<[u32; 4]> {
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() != 4 {
        return None;
    }
    let mut octets = [0u32; 4];
    for (index, part) in parts.iter().enumerate() {
        if part.is_empty() || part.len() > 3 || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        octets[index] = part.parse().ok()?;
    }
    Some(octets)
}

/// `/^[a-zA-Z0-9]([a-zA-Z0-9\-_]*[a-zA-Z0-9])?$/` — alphanumeric ends, and
/// `-`/`_` only in the middle. ASCII classes over bytes are sound: every
/// non-ASCII UTF-8 byte sits above 0x7F and fails the classes anyway.
fn is_valid_hostname_label(label: &str) -> bool {
    let bytes = label.as_bytes();
    if bytes.is_empty() || !bytes[0].is_ascii_alphanumeric() {
        return false;
    }
    if bytes.len() == 1 {
        return true;
    }
    if !bytes[bytes.len() - 1].is_ascii_alphanumeric() {
        return false;
    }
    bytes[1..bytes.len() - 1]
        .iter()
        .all(|b| b.is_ascii_alphanumeric() || *b == b'-' || *b == b'_')
}

fn is_truthy_env(value: Option<&str>) -> bool {
    match value {
        Some(raw) => {
            let normalized = crate::js::js_trim(raw).to_lowercase();
            matches!(normalized.as_str(), "1" | "true" | "yes")
        }
        None => false,
    }
}

/// `isChildProcessPermissionModelEnabled` — ENABLED BY DEFAULT; the dev
/// override can only turn it off outside production.
pub fn is_child_process_permission_model_enabled(env: EnvReader) -> bool {
    if env("NODE_ENV").as_deref() == Some("production") {
        return true;
    }
    !is_truthy_env(env(UNSANDBOXED_CHILDREN_OVERRIDE_VAR).as_deref())
}

/// `validateChildProcessPermissions` — throws (JS) / errors (Rust) on any
/// disallowed allowlist entry. The permission-model toggle itself needs no
/// validation: it is enabled by default, honors only the dev override, and
/// ignores that override in production.
pub fn validate_child_process_permissions(
    allow_net_var: Option<&str>,
    env: EnvReader,
) -> Result<(), String> {
    let var = allow_net_var.unwrap_or(DEFAULT_ALLOW_NET_VAR);
    let Some(raw) = env(var) else {
        return Ok(());
    };
    let (_, invalid) = parse_allow_net(&raw);
    if !invalid.is_empty() {
        return Err(format!(
            "SCRIPT_CHILD_ALLOW_NET contains disallowed entries: {joined}. \
             Wildcard or 0.0.0.0/0 allowlists are not permitted.",
            joined = invalid.join(", ")
        ));
    }
    Ok(())
}
