//! Deterministic error-code schema (port of packages/shared/src/error-codes.js).
//!
//! Codes partition failures into transient (retry with backoff) and permanent
//! (dead-letter / finalize) categories; UNKNOWN defaults to transient because
//! finalizing a recoverable failure on-chain is the worse outcome. The
//! substring/regex classification matches the JS oracle so the same message
//! always maps to the same level.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    TransientNetwork,
    TransientRateLimit,
    TransientWorker,
    PermanentConfig,
    PermanentAlreadyFulfilled,
    PermanentInvalidRequest,
    Unknown,
}

impl ErrorCode {
    pub fn as_str(&self) -> &'static str {
        match self {
            ErrorCode::TransientNetwork => "TRANSIENT_NETWORK",
            ErrorCode::TransientRateLimit => "TRANSIENT_RATE_LIMIT",
            ErrorCode::TransientWorker => "TRANSIENT_WORKER",
            ErrorCode::PermanentConfig => "PERMANENT_CONFIG",
            ErrorCode::PermanentAlreadyFulfilled => "PERMANENT_ALREADY_FULFILLED",
            ErrorCode::PermanentInvalidRequest => "PERMANENT_INVALID_REQUEST",
            ErrorCode::Unknown => "UNKNOWN",
        }
    }

    /// Legacy classifier string level used by the relayer.
    pub fn level(&self) -> &'static str {
        match self {
            ErrorCode::TransientNetwork
            | ErrorCode::TransientRateLimit
            | ErrorCode::TransientWorker => "transient",
            ErrorCode::PermanentConfig => "permanent",
            ErrorCode::PermanentAlreadyFulfilled => "settled",
            ErrorCode::PermanentInvalidRequest => "permanent",
            ErrorCode::Unknown => "unknown",
        }
    }

    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            ErrorCode::TransientNetwork
                | ErrorCode::TransientRateLimit
                | ErrorCode::TransientWorker
                | ErrorCode::Unknown
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Classification {
    pub level: &'static str,
    pub code: ErrorCode,
    pub retryable: bool,
}

/// Sentinel marker appended to transient worker failures by the prepare lanes.
const TRANSIENT_WORKER_ERROR_MARKER: &str = "[transient-worker-status]";

fn contains(haystack: &str, needle: &str) -> bool {
    haystack.contains(needle)
}

/// Regex `\b...\b` with JS `\w = [A-Za-z0-9_]` boundaries.
fn contains_word(haystack: &str, needle: &str) -> bool {
    let bytes = haystack.as_bytes();
    let pattern = needle.as_bytes();
    if pattern.is_empty() || pattern.len() > bytes.len() {
        return false;
    }
    let is_word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    for start in 0..=(bytes.len() - pattern.len()) {
        if &bytes[start..start + pattern.len()] != pattern {
            continue;
        }
        let before_ok = start == 0 || !is_word(bytes[start - 1]);
        let end = start + pattern.len();
        let after_ok = end == bytes.len() || !is_word(bytes[end]);
        if before_ok && after_ok {
            return true;
        }
    }
    false
}

/// `\bfault` — boundary required only BEFORE the match.
fn contains_word_prefix(haystack: &str, needle: &str) -> bool {
    let bytes = haystack.as_bytes();
    let pattern = needle.as_bytes();
    if pattern.is_empty() || pattern.len() > bytes.len() {
        return false;
    }
    let is_word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    for start in 0..=(bytes.len() - pattern.len()) {
        if &bytes[start..start + pattern.len()] == pattern
            && (start == 0 || !is_word(bytes[start - 1]))
        {
            return true;
        }
    }
    false
}

fn is_already_fulfilled(normalized: &str) -> bool {
    contains(normalized, "already fulfilled")
        || contains(normalized, "request already fulfilled")
        || contains(normalized, "reason: request already fulfilled")
}

fn is_terminal_configuration(normalized: &str) -> bool {
    contains(normalized, "reason: unauthorized")
        || contains(normalized, "unauthorized")
        || contains(normalized, "unauthorised")
        || contains(normalized, "forbidden")
        || contains(normalized, "invalid signature")
        || contains(normalized, "verifier rejected signature")
        || contains(normalized, "oracle verifier")
        || contains(normalized, "oracle_verifier")
        || contains(normalized, "updater not set")
        || contains(normalized, "callback not allowed")
        || (contains(normalized, "called contract") && contains(normalized, "not found"))
}

fn is_transient_worker(normalized: &str) -> bool {
    if contains(normalized, TRANSIENT_WORKER_ERROR_MARKER) {
        return true;
    }
    [429, 408, 425, 500, 502, 503, 504]
        .iter()
        .any(|code| contains_word(normalized, &code.to_string()))
}

fn is_transient_network(normalized: &str) -> bool {
    contains(normalized, "etimedout")
        || contains(normalized, "econnrefused")
        || contains(normalized, "econnreset")
        || contains(normalized, "socket hang up")
        || contains(normalized, "network")
        || contains(normalized, "timed out")
        || contains(normalized, "unavailable")
}

fn is_rate_limit(normalized: &str) -> bool {
    contains(normalized, "rate limit")
}

fn is_permanent_invalid(normalized: &str) -> bool {
    contains_word(normalized, "not found")
        || contains_word_prefix(normalized, "fault")
        || contains_word(normalized, "unauthorized")
        || contains_word(normalized, "unauthorised")
        || contains_word(normalized, "forbidden")
        || contains_word(normalized, "invalid")
}

/// Classify a free-text error message (port of `classifyErrorMessage`). The
/// priority order IS the contract: settled, permanent-config, transient
/// worker/network/rate-limit, permanent-invalid, unknown.
pub fn classify_error_message(message: &str) -> Classification {
    let normalized = message.to_lowercase();
    let result = if is_already_fulfilled(&normalized) {
        ErrorCode::PermanentAlreadyFulfilled
    } else if is_terminal_configuration(&normalized) {
        ErrorCode::PermanentConfig
    } else if is_transient_worker(&normalized) {
        ErrorCode::TransientWorker
    } else if is_transient_network(&normalized) {
        ErrorCode::TransientNetwork
    } else if is_rate_limit(&normalized) {
        ErrorCode::TransientRateLimit
    } else if is_permanent_invalid(&normalized) {
        ErrorCode::PermanentInvalidRequest
    } else {
        ErrorCode::Unknown
    };
    Classification {
        level: result.level(),
        code: result,
        retryable: result.is_retryable(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn priority_matches_js_oracle() {
        let c = classify_error_message("request already fulfilled on chain");
        assert_eq!(c.code, ErrorCode::PermanentAlreadyFulfilled);
        let c = classify_error_message("unauthorized verifier");
        assert_eq!(c.code, ErrorCode::PermanentConfig);
        let c = classify_error_message("worker returned 503");
        assert_eq!(c.code, ErrorCode::TransientWorker);
        let c = classify_error_message("ETIMEDOUT while fetching");
        assert_eq!(c.code, ErrorCode::TransientNetwork);
        let c = classify_error_message("rate limit exceeded upstream");
        assert_eq!(c.code, ErrorCode::TransientRateLimit);
        let c = classify_error_message("feed not found");
        assert_eq!(c.code, ErrorCode::PermanentInvalidRequest);
        let c = classify_error_message("mysterious failure");
        assert_eq!(c.code, ErrorCode::Unknown);
        assert!(c.retryable);
    }

    #[test]
    fn word_boundaries_match_the_regexes() {
        // JS oracle: /\b(429|408|425|500|502|503|504)\b/ — "1500" has no word
        // boundary before "500" and must NOT match.
        assert!(!contains_word("status: 1500", "500"));
        assert!(!contains_word("status: 1500x", "500"));
        assert!(contains_word("status: 500", "500"));
        assert!(contains_word_prefix("fault: detail", "fault"));
        assert!(!contains_word_prefix("default: detail", "fault"));
    }
}
