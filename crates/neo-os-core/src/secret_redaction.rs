//! Canonical secret-name detection shared by every redaction sink (port of
//! workers/morpheus-relayer/src/lib/secret-redaction.js).
//!
//! Two sinks decide whether an identifier names a secret: config introspection
//! (env-var NAMES) and the structured logger (object KEYS). The fragment list
//! is the union of both former JS lists, so neither sink can lose coverage
//! relative to the other. Fragments are matched case-insensitively as
//! substrings with NO word boundaries — over-redaction is the safe direction.
//!
//! The three value-shape patterns scrub free-text strings (error messages,
//! response bodies): Bearer/Basic credentials, Neo N3 WIFs, and 64-hex values
//! immediately following a secret-ish key name. A bare 64-hex string (tx hash,
//! public digest) is deliberately NOT scrubbed.
//!
//! Regex parity notes: JS `\b` is the ASCII word boundary, reproduced here
//! with `(?-u:\b)` on the bytes engine (Unicode `\b` would diverge on
//! non-ASCII neighbours). JS `\s` differs from `\p{White_Space}` (JS has
//! U+FEFF, Rust has U+0085), so the JS set is spelled out explicitly.

use std::sync::LazyLock;

use regex::bytes::Regex;

/// JS `\s` character class (ECMA-262 WhiteSpace + LineTerminator), verbatim.
const JS_WS: &str = r"[\t\n\x0b\x0c\r \u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]";

/// Case-insensitive substring fragments (port of SECRET_NAME_FRAGMENTS —
/// `_?` marks an optional underscore, matching snake_case env names and
/// camelCase/compact object keys alike).
pub static SECRET_NAME_FRAGMENTS: &[&str] = &[
    "wif",
    "private_?key",
    "api_?key",
    "secret",
    "token",
    "service_?role_?key",
    "service_?key",
    "password",
    "passphrase",
    "seed",
    "mnemonic",
    "authorization",
    "envelope",
    "plaintext",
];

static SECRET_NAME_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!("(?i)({})", SECRET_NAME_FRAGMENTS.join("|")))
        .expect("secret-name pattern is statically valid")
});

/// True when an identifier (env-var name or object key) names a secret-shaped
/// value that must be redacted (port of `isSecretName`).
pub fn is_secret_name(value: &str) -> bool {
    SECRET_NAME_PATTERN.is_match(value.as_bytes())
}

struct ValuePattern {
    #[allow(dead_code)]
    source: &'static str,
    pattern: LazyLock<Regex>,
    replacement: &'static str,
}

/// Value-shape redaction patterns, applied in order (port of
/// SECRET_VALUE_PATTERNS).
static SECRET_VALUE_PATTERNS: LazyLock<Vec<ValuePattern>> = LazyLock::new(|| {
    vec![
        ValuePattern {
            source: "bearer",
            // Case-insensitive on purpose; the credential must be at least 20
            // chars so prose like "invalid bearer" is not scrubbed.
            pattern: LazyLock::new(|| {
                Regex::new(&format!(
                    r"(?i)(?-u:\b)(Bearer|Basic){JS_WS}+[A-Za-z0-9._~+/=-]{{20,}}"
                ))
                .expect("bearer pattern is statically valid")
            }),
            replacement: "${1} [REDACTED]",
        },
        ValuePattern {
            source: "wif",
            // 52-char base58check WIF, starts with K or L.
            pattern: LazyLock::new(|| {
                Regex::new(r"(?-u:\b)[KL][1-9A-HJ-NP-Za-km-z]{50,51}(?-u:\b)")
                    .expect("wif pattern is statically valid")
            }),
            replacement: "[REDACTED-WIF]",
        },
        ValuePattern {
            source: "key-context-hex",
            // A 64-hex value immediately following a secret-ish key name.
            pattern: LazyLock::new(|| {
                Regex::new(&format!(
                    r"(?i)(private[_-]?key|wif|signing[_-]?key|mnemonic|seed|passphrase|secret|token)({JS_WS}*[:=]{JS_WS}*)((?:0x)?[0-9a-fA-F]{{64}})"
                ))
                .expect("key-context-hex pattern is statically valid")
            }),
            replacement: "${1}${2}[REDACTED]",
        },
    ]
});

/// Apply every value-shape redaction pattern to free text (port of
/// `redactSecretValues`). JS passes non-strings through unchanged; the Rust
/// relayer operates on `&str` at the boundary, so callers keep that duty.
pub fn redact_secret_values(text: &str) -> String {
    let mut out = text.as_bytes().to_vec();
    for entry in SECRET_VALUE_PATTERNS.iter() {
        out = entry
            .pattern
            .replace_all(&out, entry.replacement.as_bytes())
            .into_owned();
    }
    String::from_utf8(out).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_detection_covers_both_former_lists() {
        assert!(!is_secret_name("NEOX_UPDATER_PK".to_lowercase().as_str()));
        assert!(!is_secret_name("MORPHEUS_RELAYER_NEOX_UPDATER_PK"));
        assert!(is_secret_name("NEO_N3_WIF"));
        assert!(is_secret_name("MORPHEUS_N3_PRIVATE_KEY"));
        assert!(is_secret_name("privateKey"));
        assert!(is_secret_name("privatekey"));
        assert!(is_secret_name("FOO_API_KEY"));
        assert!(is_secret_name("SUPABASE_SERVICE_ROLE_KEY"));
        assert!(is_secret_name("serviceRoleKey"));
        assert!(is_secret_name("SIGNER_SERVICE_TOKEN"));
        assert!(!is_secret_name("MORPHEUS_NITRO_ROOT_CERT_PEM"));
        assert!(is_secret_name("seed"));
        assert!(is_secret_name("MNEMONIC"));
        assert!(is_secret_name("authorization"));
        assert!(is_secret_name("plain envelope"));
        // 'PK' alone is not secret-shaped (name-based detection).
        assert!(!is_secret_name("PK"));
    }

    #[test]
    fn bearer_redaction_keeps_scheme_and_needs_20_chars() {
        assert_eq!(
            redact_secret_values("auth: Bearer abcdefghijklmnopqrstuvwxyz"),
            "auth: Bearer [REDACTED]"
        );
        assert_eq!(
            redact_secret_values("invalid bearer"),
            "invalid bearer",
            "short credentials must survive"
        );
        assert_eq!(
            redact_secret_values("Basic bm90LXJlYWxseS1hLXNlY3JldC1qdXN0LWxvbmc="),
            "Basic [REDACTED]"
        );
    }

    #[test]
    fn wif_redaction() {
        // 52-char WIF (K-prefixed base58check shape).
        let wif = "KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn";
        assert_eq!(wif.len(), 52);
        assert_eq!(redact_secret_values(wif), "[REDACTED-WIF]");
        // A bare 64-hex tx hash must NOT be scrubbed.
        let hash = "a".repeat(64);
        assert_eq!(redact_secret_values(&hash), hash);
    }

    #[test]
    fn key_context_hex_redaction() {
        let hex = "b".repeat(64);
        assert_eq!(
            redact_secret_values(&format!("private_key: {hex}")),
            "private_key: [REDACTED]"
        );
        // The `0x` prefix sits inside the consumed capture group, so JS
        // replacement '$1$2[REDACTED]' drops it.
        assert_eq!(
            redact_secret_values(&format!("token=0x{hex}")),
            "token=[REDACTED]"
        );
        // Only 63 hex digits — below the threshold, must survive.
        assert_eq!(
            redact_secret_values(&format!("seed: {}", "c".repeat(63))),
            format!("seed: {}", "c".repeat(63))
        );
    }
}
