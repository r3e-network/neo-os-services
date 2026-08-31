//! Bearer-token auth — the direct port of `enclave-server.mjs`'s trusted-token
//! set (lines ~167-278). Three properties carry over unchanged:
//!
//! * The trusted set is derived LIVE from the environment (the overlay), so a
//!   `/provision` that installs a materialized runtime token takes effect on
//!   the next request.
//! * Placeholder values from copied env examples are refused at resolution —
//!   an empty trusted set stays fail-closed (401) rather than accepting a
//!   publicly guessable secret.
//! * The comparison is constant-time. The Node server compares raw bytes and
//!   leaks length by early-returning on mismatch; here both sides are folded
//!   through sha256 first, which compares fixed 32-byte digests and leaks
//!   nothing — the same pattern the custody service's `auth` module uses for
//!   its caller tokens.

use sha2::{Digest, Sha256};

use crate::overlay::EnvOverlay;
use crate::{http_error, RuntimeError};

/// The env keys whose non-empty values form the trusted bearer-token set.
pub const TOKEN_ENV_KEYS: [&str; 4] = [
    "NITRO_SIGNER_TOKEN",
    "MORPHEUS_RUNTIME_TOKEN",
    "NITRO_API_TOKEN",
    "NITRO_SHARED_SECRET",
];

/// `MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64` — the ciphertext envelope
/// the FIRST provision must present (and later rotations re-present with a
/// strictly newer version).
pub const RUNTIME_TOKEN_KMS_CIPHERTEXT_ENV: &str = "MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64";

/// The KMS envelope's purpose string. An envelope released for any other
/// purpose must not authorize this enclave.
pub const RUNTIME_TOKEN_KMS_PURPOSE: &str = "neoos/nitro-runtime-auth/v1";

/// Deployment hygiene: an operator copying an env example verbatim must not
/// ship a public guess as the runtime auth token. Matched case-insensitively
/// against the trimmed value.
const PLACEHOLDER_TOKEN_VALUES: [&str; 8] = [
    "replace-me",
    "changeme",
    "change-me",
    "your-token-here",
    "your-morpheus-runtime-token",
    "nitro-shared-secret",
    "secret",
    "token",
];

pub fn is_placeholder_token(value: &str) -> bool {
    let trimmed = value.trim().to_ascii_lowercase();
    PLACEHOLDER_TOKEN_VALUES.contains(&trimmed.as_str())
}

/// `currentTrustedTokens()`: the non-placeholder values of the token env keys,
/// in env-key order, deduplicated. A placeholder value is refused with a note
/// on stderr and the set stays closed around it.
pub fn trusted_tokens(overlay: &EnvOverlay) -> Vec<String> {
    let mut tokens: Vec<String> = Vec::new();
    for key in TOKEN_ENV_KEYS {
        let Some(value) = overlay.get_trimmed(key) else {
            continue;
        };
        if is_placeholder_token(&value) {
            eprintln!(
                "[enclave-host] refusing placeholder value for {key}; set a real secret (the trusted-token set stays closed)"
            );
            continue;
        }
        if !tokens.contains(&value) {
            tokens.push(value);
        }
    }
    tokens
}

/// Constant-time equality over fixed-size digests. Folding the two sha256
/// digests through XOR and collapsing to a single byte keeps the comparison
/// constant-time without a length leak — the Node `timingSafeTokenMatch`
/// early-returns on `a.length !== b.length`, which leaks token length; the
/// digest form cannot, because every input is 32 bytes by the time it is
/// compared.
pub fn timing_safe_token_match(candidate: &str, trusted: &str) -> bool {
    let candidate_digest = Sha256::digest(candidate.as_bytes());
    let trusted_digest = Sha256::digest(trusted.as_bytes());
    candidate_digest
        .iter()
        .zip(trusted_digest.iter())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

/// `extractRequestToken`: `Authorization: Bearer <t>` (case-insensitive
/// scheme) preferred, else `x-nitro-token`, else `x-runtime-token`. Absent
/// everywhere this is the empty string — which can only match an empty
/// trusted token, and the trusted set never contains one.
pub fn extract_request_token(headers: &http::HeaderMap) -> String {
    let authorization = headers
        .get(http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .trim();
    let bearer = if authorization.len() >= 7 && authorization[..7].eq_ignore_ascii_case("bearer ") {
        authorization[7..].trim().to_string()
    } else {
        String::new()
    };
    if !bearer.is_empty() {
        return bearer;
    }
    // Node: `trimString(headers['x-nitro-token'] || headers['x-runtime-token'])`
    // — the first PRESENT header wins even when whitespace-only, and then the
    // trim can still empty it. The empty result can never authenticate.
    for name in ["x-nitro-token", "x-runtime-token"] {
        if let Some(value) = headers.get(name).and_then(|value| value.to_str().ok()) {
            return value.trim().to_string();
        }
    }
    String::new()
}

/// `assertAuthorized`: 401 unless a trusted token is configured AND the
/// request bears a match. An empty trusted set is always closed.
pub fn assert_authorized(
    overlay: &EnvOverlay,
    headers: &http::HeaderMap,
) -> Result<(), RuntimeError> {
    let trusted = trusted_tokens(overlay);
    if trusted.is_empty() {
        return Err(http_error(401, "runtime authorization is not configured"));
    }
    let token = extract_request_token(headers);
    for trusted_token in &trusted {
        if timing_safe_token_match(&token, trusted_token) {
            return Ok(());
        }
    }
    Err(http_error(401, "unauthorized"))
}

#[cfg(test)]
#[path = "../tests/unit/auth.rs"]
mod tests;
