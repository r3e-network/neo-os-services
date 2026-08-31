//! The environment the host reads. The enclave boots with only the baked image
//! ENV, so `/provision` is what injects network, worker config and the runtime
//! token at runtime — the Node server writes them into `process.env` and every
//! read site observes them. This overlay is the same thing, but as a value the
//! library owns instead of a process-global: the base half is a snapshot taken
//! at construction (which, inside the enclave, is the image ENV and cannot
//! change), and the provisioned half shadows it. Tests construct one from an
//! iterator instead of mutating `std::env`, which keeps the test suites
//! parallelizable without a global lock.

use std::collections::BTreeMap;

/// `^[A-Z0-9_]{1,96}$` — the only env names a provision body may set. The Node
/// server silently SKIPS non-matching keys (they are not applied and not
/// reported); so does [`EnvOverlay::apply`].
pub fn is_provisionable_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 96
        && bytes
            .iter()
            .all(|b| matches!(b, b'A'..=b'Z' | b'0'..=b'9' | b'_'))
}

#[derive(Debug, Clone, Default)]
pub struct EnvOverlay {
    base: BTreeMap<String, String>,
    overlay: BTreeMap<String, String>,
}

impl EnvOverlay {
    /// The production constructor: snapshot `std::env` once. Inside the
    /// enclave the image ENV is fixed at boot, so the snapshot is the whole
    /// truth; the process-global env is never read again.
    pub fn from_process() -> Self {
        EnvOverlay {
            base: std::env::vars().collect(),
            overlay: BTreeMap::new(),
        }
    }

    /// The test constructor: an explicit base. Provisioned values still shadow
    /// it exactly as they shadow the image ENV in production.
    pub fn new<I, K, V>(base: I) -> Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<String>,
        V: Into<String>,
    {
        EnvOverlay {
            base: base
                .into_iter()
                .map(|(k, v)| (k.into(), v.into()))
                .collect(),
            overlay: BTreeMap::new(),
        }
    }

    /// Overlay-first lookup. Unlike the auth reads this is the raw value —
    /// every call site in the Node server re-trims, so the trim lives at the
    /// read helpers ([`Self::get_trimmed`], [`auth::trusted_tokens`]).
    pub fn get(&self, name: &str) -> Option<&str> {
        self.overlay
            .get(name)
            .or_else(|| self.base.get(name))
            .map(String::as_str)
    }

    /// `trimString(process.env[name])` — the form every read site actually
    /// uses. Non-strings collapse to empty in the Node helper, which here
    /// means an absent or whitespace-only value reads as `None`.
    pub fn get_trimmed(&self, name: &str) -> Option<String> {
        self.get(name)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    }

    /// The provision write: apply `value` under `name` when the name is
    /// provisionable and the trimmed value is non-empty, mirroring
    /// `handleProvision`'s apply loop (which skips rather than errors).
    /// Returns whether the key was applied.
    pub fn apply(&mut self, name: &str, value: &serde_json::Value) -> bool {
        if !is_provisionable_name(name) {
            return false;
        }
        // trimString is string-only: a JSON number or object in the provision
        // body is skipped, not stringified.
        let Some(text) = value.as_str() else {
            return false;
        };
        let text = text.trim();
        if text.is_empty() {
            return false;
        }
        self.overlay.insert(name.to_string(), text.to_string());
        true
    }

    /// The one write that bypasses the provision whitelist: the runtime token
    /// materialized from the KMS envelope. `handleProvision` writes it into
    /// `process.env.MORPHEUS_RUNTIME_TOKEN` directly, and auth reads it from
    /// there on the next request.
    pub fn set_runtime_token(&mut self, token: &str) {
        self.overlay
            .insert("MORPHEUS_RUNTIME_TOKEN".to_string(), token.to_string());
    }

    /// The env names the provision response reports — the applied keys, the
    /// way `Object.entries` saw them. The caller sorts.
    pub fn applied_keys(&self) -> impl Iterator<Item = &str> {
        self.overlay.keys().map(String::as_str)
    }

    /// The full view (base shadowed by provisioned) as an owned map — the env
    /// the keyless compute child is spawned with. This is exactly the
    /// `process.env` the merged server accumulated.
    pub fn merged_map(&self) -> BTreeMap<String, String> {
        let mut merged = self.base.clone();
        merged.extend(
            self.overlay
                .iter()
                .map(|(key, value)| (key.clone(), value.clone())),
        );
        merged
    }
}

#[cfg(test)]
#[path = "../tests/unit/overlay.rs"]
mod tests;
