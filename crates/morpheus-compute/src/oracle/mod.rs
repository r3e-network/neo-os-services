//! Port of `workers/nitro-worker/src/oracle/*` — Phase 5b, the oracle lane.
//!
//! Same disciplines as Phase 5a: the JS module is the byte-level oracle, JS
//! test suites are ported as Rust fixtures, everything that read `process.env`
//! takes an [`crate::core::EnvReader`] and no handler wiring happens until the
//! lane lands.

pub mod aggregation;
pub mod crypto;
pub mod decimal;
pub mod feed_registry;
pub mod feeds;
pub mod fetch;
pub mod message_reveal;
pub mod providers;

use serde_json::Value as Json;

use crate::js::js_trim_string;

/// `normalizeProviderId(value)` (providers.js) —
/// `trimString(value || '').toLowerCase()`; every falsy value collapses to ''
/// before the trim, so `normalizeProviderId(0)` is ''.
pub fn normalize_provider_id(value: &Json) -> String {
    js_trim_string(Some(value)).to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn provider_ids_collapse_falsy_values_before_the_trim() {
        assert_eq!(normalize_provider_id(&json!("TWELVEDATA")), "twelvedata");
        assert_eq!(
            normalize_provider_id(&json!("  Binance-Spot  ")),
            "binance-spot"
        );
        assert_eq!(normalize_provider_id(&json!(0)), "");
        assert_eq!(normalize_provider_id(&Json::Null), "");
        assert_eq!(normalize_provider_id(&json!(5)), "5");
    }
}
