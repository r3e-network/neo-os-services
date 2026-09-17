//! Reviewed N3 network identity. The per-network registry remains authority;
//! no endpoint response or signing request can define its own expected magic.
use crate::{CoreError, CoreResult};
use std::sync::OnceLock;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NeoN3Identity {
    pub magic: u32,
    pub genesis_hash: String,
}

/// Public release configuration embedded with the binary, independent of cwd.
/// Unknown networks have no registry fallback.
pub fn known_network_registry(network: &str) -> Option<&'static serde_json::Value> {
    static MAINNET: OnceLock<serde_json::Value> = OnceLock::new();
    static TESTNET: OnceLock<serde_json::Value> = OnceLock::new();
    let (slot, source) = match network {
        "mainnet" => (
            &MAINNET,
            include_str!("../../../config/networks/mainnet.json"),
        ),
        "testnet" => (
            &TESTNET,
            include_str!("../../../config/networks/testnet.json"),
        ),
        _ => return None,
    };
    Some(slot.get_or_init(|| {
        serde_json::from_str(source).expect("reviewed network registry must parse")
    }))
}

fn is_canonical_genesis_hash(hash: &str) -> bool {
    hash.len() == 66
        && hash.starts_with("0x")
        && hash[2..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && hash[2..].bytes().any(|b| b != b'0')
}

pub fn known_neo_n3_identity(network: &str) -> Option<&'static NeoN3Identity> {
    static MAINNET: OnceLock<NeoN3Identity> = OnceLock::new();
    static TESTNET: OnceLock<NeoN3Identity> = OnceLock::new();
    let slot = match network {
        "mainnet" => &MAINNET,
        "testnet" => &TESTNET,
        _ => return None,
    };
    Some(slot.get_or_init(|| {
        let registry = known_network_registry(network).expect("known network has a registry");
        let magic = registry
            .pointer("/neo_n3/network_magic")
            .and_then(serde_json::Value::as_u64)
            .and_then(|v| u32::try_from(v).ok())
            .filter(|v| *v > 0)
            .expect("reviewed magic must be positive uint32");
        let genesis_hash = registry
            .pointer("/neo_n3/genesis_hash")
            .and_then(serde_json::Value::as_str)
            .expect("reviewed genesis is required")
            .to_owned();
        assert!(
            is_canonical_genesis_hash(&genesis_hash),
            "reviewed genesis must be canonical nonzero hex"
        );
        NeoN3Identity {
            magic,
            genesis_hash,
        }
    }))
}

/// Validate the resolved value without changing the legacy config coercion API.
/// Known labels must match the registry. This function does not authorize a
/// custom custody key: unknown networks remain rejected by the custody guard.
pub fn validate_neo_n3_magic(network: &str, value: f64) -> CoreResult<u32> {
    if !value.is_finite() || value.fract() != 0.0 || value <= 0.0 || value > u32::MAX as f64 {
        return Err(CoreError::new(
            "Neo N3 network magic must be a positive uint32 integer",
        ));
    }
    let magic = value as u32;
    if let Some(expected) = known_neo_n3_identity(network) {
        if magic != expected.magic {
            return Err(CoreError::new(format!(
                "Neo N3 network magic conflicts with reviewed {network} identity"
            )));
        }
    }
    Ok(magic)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn genesis_validation_requires_canonical_nonzero_hash() {
        for hash in [
            format!("0x{}", "0".repeat(64)),
            format!("0x{}", "A".repeat(64)),
            format!("0x{}", "a".repeat(63)),
            format!("0x{}", "a".repeat(65)),
            "a".repeat(64),
        ] {
            assert!(!is_canonical_genesis_hash(&hash), "accepted {hash}");
        }
        assert!(is_canonical_genesis_hash(&format!("0x{}1", "0".repeat(63))));
        assert!(is_canonical_genesis_hash(
            &known_neo_n3_identity("mainnet").unwrap().genesis_hash
        ));
        assert!(is_canonical_genesis_hash(
            &known_neo_n3_identity("testnet").unwrap().genesis_hash
        ));
    }
    #[test]
    fn known_identity_is_registry_backed_and_unknown_has_no_default() {
        assert_eq!(known_neo_n3_identity("mainnet").unwrap().magic, 860833102);
        assert_eq!(known_neo_n3_identity("testnet").unwrap().magic, 894710606);
        for value in ["private-A", "Mainnet", "", "testnet "] {
            assert!(known_neo_n3_identity(value).is_none());
        }
    }
    #[test]
    fn reject_known_network_drift_and_non_integer_magic() {
        for (label, magic) in [("mainnet", 860833102.0), ("testnet", 894710606.0)] {
            assert!(validate_neo_n3_magic(label, magic).is_ok());
        }
        for value in [
            894710606.0,
            0.0,
            -1.0,
            1.5,
            4294967296.0,
            f64::NAN,
            f64::INFINITY,
        ] {
            assert!(validate_neo_n3_magic("mainnet", value).is_err());
        }
        assert!(validate_neo_n3_magic("testnet", 860833102.0).is_err());
    }
}
