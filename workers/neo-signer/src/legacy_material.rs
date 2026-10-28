//! A strict decoder for the two legacy N3 roles, not an import or release API.
//!
//! The caller must first authenticate the attested KMS release and obtain the
//! expected public key and role from an admitted immutable manifest. This pure
//! helper neither establishes that authority nor accepts a key from HTTP/env.
//! It returns only identity-matching P-256 material; no key is generated.

use serde::de::{DeserializeSeed, Error as _, MapAccess, Visitor};
use zeroize::Zeroizing;

/// Only the two existing mainnet N3 material formats are supported.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LegacyN3Role {
    OracleVerifier,
    Updater,
}

impl LegacyN3Role {
    fn accepts(self, field: &str) -> bool {
        field == "wif"
            || field == "private_key"
            || match self {
                Self::OracleVerifier => field == "oracle_verifier_wif",
                Self::Updater => field == "updater_wif",
            }
    }
}

/// Fixed, non-secret errors. Never include input, parser details or WIF text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LegacyMaterialError {
    Format,
    InvalidExpectedIdentity,
    InvalidPrivateKey,
    IdentityMismatch,
}

impl std::fmt::Display for LegacyMaterialError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Format => "legacy N3 material format refused",
            Self::InvalidExpectedIdentity => "legacy N3 expected identity refused",
            Self::InvalidPrivateKey => "legacy N3 private key refused",
            Self::IdentityMismatch => "legacy N3 identity mismatch",
        })
    }
}

impl std::error::Error for LegacyMaterialError {}

struct MaterialSeed(LegacyN3Role);

impl<'de> DeserializeSeed<'de> for MaterialSeed {
    type Value = Zeroizing<String>;

    fn deserialize<D: serde::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> Result<Self::Value, D::Error> {
        struct MaterialVisitor(LegacyN3Role);
        impl<'de> Visitor<'de> for MaterialVisitor {
            type Value = Zeroizing<String>;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("one explicit legacy N3 WIF field")
            }
            fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
                let field: String = map.next_key()?.ok_or_else(|| M::Error::custom("empty"))?;
                if !self.0.accepts(&field) {
                    return Err(M::Error::custom("field refused"));
                }
                let value = Zeroizing::new(map.next_value::<String>()?);
                // Reject both duplicates and competing aliases, even when equal.
                if map.next_key::<String>()?.is_some() {
                    return Err(M::Error::custom("additional field refused"));
                }
                Ok(value)
            }
        }
        deserializer.deserialize_map(MaterialVisitor(self.0))
    }
}

/// Decode compressed WIF, directly or in one role-appropriate JSON field.
///
/// Limits: <=4096 input bytes, one JSON field, exactly 52 Base58 characters,
/// checksum, 0x80 version and 0x01 compressed marker. Hex/NEP-2/uncompressed
/// WIF and permissive alias selection are deliberately unsupported. The public
/// identity must be a valid canonical compressed P-256 point and must match.
/// Owned WIF and decoded buffers are zeroized on every return. The supplied
/// release buffer remains owned by the caller, which must also zeroize it.
/// serde_json may use internal parsing scratch; this is not an allocator-wide
/// erasure guarantee.
pub fn decode_identity_bound_n3_material(
    released: &[u8],
    role: LegacyN3Role,
    expected_public_key: &[u8; 33],
) -> Result<Zeroizing<[u8; 32]>, LegacyMaterialError> {
    use LegacyMaterialError as E;
    if released.is_empty() || released.len() > 4096 {
        return Err(E::Format);
    }
    if crate::crypto::compress_public_key(expected_public_key).as_ref() != Some(expected_public_key)
    {
        return Err(E::InvalidExpectedIdentity);
    }
    let text = std::str::from_utf8(released).map_err(|_| E::Format)?;
    let text = text.trim_matches(|c: char| c.is_ascii_whitespace());
    let owned;
    let wif = if text.starts_with('{') {
        let mut deserializer = serde_json::Deserializer::from_str(text);
        owned = MaterialSeed(role)
            .deserialize(&mut deserializer)
            .map_err(|_| E::Format)?;
        deserializer.end().map_err(|_| E::Format)?;
        owned.as_str()
    } else {
        text
    };
    if wif.len() != 52 || !wif.is_ascii() {
        return Err(E::Format);
    }
    let mut decoded = Zeroizing::new([0u8; 38]);
    let count = bs58::decode(wif)
        .with_check(Some(0x80))
        .onto(&mut decoded[..])
        .map_err(|_| E::Format)?;
    if count != 34 || decoded[0] != 0x80 || decoded[33] != 0x01 {
        return Err(E::Format);
    }
    let mut private_key = Zeroizing::new([0u8; 32]);
    private_key.copy_from_slice(&decoded[1..33]);
    let public_key =
        crate::crypto::public_key_from_private(&private_key).map_err(|_| E::InvalidPrivateKey)?;
    if &public_key != expected_public_key {
        return Err(E::IdentityMismatch);
    }
    Ok(private_key)
}

#[cfg(test)]
#[path = "../tests/unit/legacy_material.rs"]
mod tests;
