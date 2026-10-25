//! Immutable identity for one durable custody vault.
//!
//! A profile is public configuration, but it is security-sensitive: the
//! measured release or an offline signing root must pin its digest. Runtime
//! environment variables must never be allowed to rewrite these fields.

use std::collections::HashSet;

use anyhow::{Context, Result};
use p256::PublicKey;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;

use crate::{
    network::{self, ChainFamily, Network},
    vault::MasterKey,
};

pub const PROFILE_VERSION: u32 = 1;
pub const SNAPSHOT_FORMAT_VERSION: u32 = 2;
pub const SIGNER_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VaultProfile {
    pub profile_version: u32,
    pub vault_id: String,
    pub environment: String,
    pub networks: Vec<VaultNetwork>,
    pub custody_kms_key_arn: String,
    pub root_key_version: String,
    pub root_key_commitment: String,
    pub snapshot_format_version: u32,
    pub signer_schema_version: u32,
    pub coordinator: CoordinatorProfile,
    pub release_policy_version: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VaultNetwork {
    pub chain_family: String,
    pub chain_id: u64,
    pub genesis_hash: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CoordinatorProfile {
    pub origin: String,
    pub aws_region: String,
    pub snapshot_bucket: String,
    pub snapshot_prefix: String,
    pub receipt_keys: Vec<ReceiptVerifierKey>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReceiptVerifierKey {
    pub key_id: String,
    pub public_key_sec1_hex: String,
}

/// A profile whose normalized identifiers and cryptographic bindings have all
/// been checked. Keeping the source document private prevents post-validation
/// mutation through a public field.
#[derive(Clone, Debug)]
pub struct ValidatedVaultProfile {
    document: VaultProfile,
    environment: Network,
    vault_id: [u8; 16],
    root_key_commitment: [u8; 32],
    network_set_hash: [u8; 32],
    profile_hash: [u8; 32],
}

impl VaultProfile {
    pub fn from_json(bytes: &[u8]) -> Result<ValidatedVaultProfile> {
        let document: Self = serde_json::from_slice(bytes).context("invalid vault profile JSON")?;
        document.validate()
    }

    pub fn validate(self) -> Result<ValidatedVaultProfile> {
        anyhow::ensure!(
            self.profile_version == PROFILE_VERSION,
            "unsupported vault profile version"
        );
        anyhow::ensure!(
            self.snapshot_format_version == SNAPSHOT_FORMAT_VERSION,
            "unsupported custody snapshot format version"
        );
        anyhow::ensure!(
            self.signer_schema_version == SIGNER_SCHEMA_VERSION,
            "unsupported signer schema version"
        );

        let environment = parse_public_environment(&self.environment)?;
        let vault_id = fixed_lower_hex::<16>(&self.vault_id, "vault_id")?;
        anyhow::ensure!(vault_id != [0; 16], "vault_id must not be zero");
        let root_key_commitment =
            fixed_lower_hex::<32>(&self.root_key_commitment, "root_key_commitment")?;
        anyhow::ensure!(
            root_key_commitment != [0; 32],
            "root_key_commitment must not be zero"
        );
        validate_token(&self.root_key_version, "root_key_version", 64)?;
        validate_token(&self.release_policy_version, "release_policy_version", 64)?;

        anyhow::ensure!(
            !self.networks.is_empty() && self.networks.len() <= ChainFamily::ALL.len(),
            "networks must contain one or two public chain bindings"
        );
        let mut previous = None;
        let mut families = HashSet::new();
        for binding in &self.networks {
            let family: ChainFamily = binding
                .chain_family
                .parse()
                .context("invalid profile chain_family")?;
            anyhow::ensure!(
                binding.chain_family == family.to_string(),
                "chain_family must use its canonical spelling"
            );
            anyhow::ensure!(
                families.insert(family.to_string()),
                "duplicate chain_family"
            );
            if let Some(previous) = previous {
                anyhow::ensure!(
                    previous < binding.chain_family.as_str(),
                    "networks must be sorted by chain_family"
                );
            }
            previous = Some(binding.chain_family.as_str());
            let expected_chain_id = match family {
                ChainFamily::NeoN3 => u64::from(network::network_magic(environment)),
                ChainFamily::NeoX => network::neox_chain_id(environment),
            };
            anyhow::ensure!(
                binding.chain_id == expected_chain_id,
                "profile chain id does not match its public environment"
            );
            fixed_prefixed_lower_hex::<32>(&binding.genesis_hash, "genesis_hash")?;
        }

        validate_coordinator(&self.coordinator)?;
        validate_kms_arn(&self.custody_kms_key_arn, &self.coordinator.aws_region)?;

        let network_set_hash = Sha256::digest(canonical_networks(&self.networks)).into();
        let profile_hash = Sha256::digest(canonical_profile(&self, &network_set_hash)).into();
        Ok(ValidatedVaultProfile {
            document: self,
            environment,
            vault_id,
            root_key_commitment,
            network_set_hash,
            profile_hash,
        })
    }
}

impl ValidatedVaultProfile {
    pub fn document(&self) -> &VaultProfile {
        &self.document
    }

    pub fn environment(&self) -> Network {
        self.environment
    }

    pub fn vault_id(&self) -> &[u8; 16] {
        &self.vault_id
    }

    pub fn root_key_commitment(&self) -> &[u8; 32] {
        &self.root_key_commitment
    }

    pub fn network_set_hash(&self) -> &[u8; 32] {
        &self.network_set_hash
    }

    pub fn profile_hash(&self) -> &[u8; 32] {
        &self.profile_hash
    }

    pub fn permits(&self, family: ChainFamily, chain_id: u64) -> bool {
        self.document.networks.iter().any(|network| {
            network.chain_family == family.to_string() && network.chain_id == chain_id
        })
    }

    pub fn verify_master(&self, master: &MasterKey) -> Result<()> {
        anyhow::ensure!(
            root_key_commitment(master) == self.root_key_commitment,
            "released root key does not match the immutable vault profile"
        );
        Ok(())
    }
}

pub fn root_key_commitment(master: &MasterKey) -> [u8; 32] {
    let mut digest = Sha256::new();
    digest.update(b"neoos/custody/root-key-commitment/v1\0");
    digest.update(master.bytes());
    digest.finalize().into()
}

fn parse_public_environment(value: &str) -> Result<Network> {
    let network: Network = value.parse().context("invalid profile environment")?;
    anyhow::ensure!(
        network != Network::Private,
        "durable vault profiles must use a public environment"
    );
    anyhow::ensure!(
        value == network.to_string(),
        "environment must use its canonical spelling"
    );
    Ok(network)
}

fn validate_coordinator(profile: &CoordinatorProfile) -> Result<()> {
    let origin = Url::parse(&profile.origin).context("invalid coordinator origin")?;
    anyhow::ensure!(
        origin.scheme() == "https",
        "coordinator origin must use HTTPS"
    );
    anyhow::ensure!(
        origin.username().is_empty() && origin.password().is_none(),
        "coordinator origin must not contain credentials"
    );
    anyhow::ensure!(
        origin.host_str().is_some(),
        "coordinator origin must name a host"
    );
    anyhow::ensure!(
        origin.path() == "/" && origin.query().is_none() && origin.fragment().is_none(),
        "coordinator origin must not contain a path, query, or fragment"
    );
    anyhow::ensure!(
        profile.origin == origin.origin().ascii_serialization(),
        "coordinator origin must be canonical and have no trailing slash"
    );
    validate_region(&profile.aws_region)?;
    validate_bucket(&profile.snapshot_bucket)?;
    validate_prefix(&profile.snapshot_prefix)?;
    anyhow::ensure!(
        !profile.receipt_keys.is_empty() && profile.receipt_keys.len() <= 4,
        "coordinator must pin one to four receipt keys"
    );
    let mut key_ids = HashSet::new();
    for key in &profile.receipt_keys {
        validate_token(&key.key_id, "receipt key id", 128)?;
        anyhow::ensure!(
            key_ids.insert(key.key_id.as_str()),
            "duplicate receipt key id"
        );
        let encoded = fixed_lower_hex::<65>(&key.public_key_sec1_hex, "receipt public key")?;
        anyhow::ensure!(
            encoded[0] == 4,
            "receipt public key must use uncompressed SEC1 encoding"
        );
        PublicKey::from_sec1_bytes(&encoded)
            .context("receipt public key is not a valid P-256 point")?;
    }
    Ok(())
}

fn validate_kms_arn(value: &str, expected_region: &str) -> Result<()> {
    let parts: Vec<_> = value.split(':').collect();
    anyhow::ensure!(
        parts.len() == 6,
        "custody_kms_key_arn must be a complete KMS key ARN"
    );
    anyhow::ensure!(
        parts[0] == "arn" && parts[2] == "kms",
        "custody_kms_key_arn must name AWS KMS"
    );
    anyhow::ensure!(
        parts[3] == expected_region,
        "KMS key and coordinator regions must match"
    );
    anyhow::ensure!(
        parts[4].len() == 12 && parts[4].bytes().all(|byte| byte.is_ascii_digit()),
        "KMS key ARN must contain a 12-digit account id"
    );
    anyhow::ensure!(
        parts[5].starts_with("key/") && parts[5].len() > 4,
        "KMS aliases are not accepted; pin a complete key ARN"
    );
    validate_token(&parts[5][4..], "KMS key id", 128)
}

fn validate_region(value: &str) -> Result<()> {
    anyhow::ensure!(
        (3..=32).contains(&value.len()),
        "aws_region length is invalid"
    );
    anyhow::ensure!(
        value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'),
        "aws_region is not canonical"
    );
    anyhow::ensure!(
        !value.starts_with('-') && !value.ends_with('-'),
        "aws_region is not canonical"
    );
    Ok(())
}

fn validate_bucket(value: &str) -> Result<()> {
    anyhow::ensure!(
        (3..=63).contains(&value.len()),
        "snapshot_bucket length is invalid"
    );
    anyhow::ensure!(
        value.bytes().all(|byte| byte.is_ascii_lowercase()
            || byte.is_ascii_digit()
            || byte == b'-'
            || byte == b'.'),
        "snapshot_bucket is not a canonical DNS bucket name"
    );
    anyhow::ensure!(
        !value.starts_with(['-', '.']) && !value.ends_with(['-', '.']) && !value.contains(".."),
        "snapshot_bucket is not a canonical DNS bucket name"
    );
    Ok(())
}

fn validate_prefix(value: &str) -> Result<()> {
    anyhow::ensure!(
        !value.is_empty() && value.len() <= 256,
        "snapshot_prefix length is invalid"
    );
    anyhow::ensure!(
        !value.starts_with('/') && !value.ends_with('/') && !value.contains("//"),
        "snapshot_prefix must be a canonical relative prefix"
    );
    anyhow::ensure!(
        value.split('/').all(|part| !part.is_empty()
            && part != "."
            && part != ".."
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))),
        "snapshot_prefix contains an unsafe segment"
    );
    Ok(())
}

fn validate_token(value: &str, name: &str, maximum: usize) -> Result<()> {
    anyhow::ensure!(
        !value.is_empty() && value.len() <= maximum,
        "{name} length is invalid"
    );
    anyhow::ensure!(
        value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')),
        "{name} is not canonical"
    );
    Ok(())
}

fn fixed_lower_hex<const N: usize>(value: &str, name: &str) -> Result<[u8; N]> {
    anyhow::ensure!(
        value.len() == N * 2
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "{name} must be lowercase fixed-length hexadecimal"
    );
    let decoded = hex::decode(value).with_context(|| format!("invalid {name}"))?;
    decoded
        .try_into()
        .map_err(|_| anyhow::anyhow!("invalid {name} length"))
}

fn fixed_prefixed_lower_hex<const N: usize>(value: &str, name: &str) -> Result<[u8; N]> {
    let encoded = value
        .strip_prefix("0x")
        .with_context(|| format!("{name} must start with 0x"))?;
    fixed_lower_hex(encoded, name)
}

fn push_field(output: &mut Vec<u8>, value: &[u8]) {
    let length = u32::try_from(value.len()).expect("validated profile field length fits u32");
    output.extend_from_slice(&length.to_be_bytes());
    output.extend_from_slice(value);
}

fn canonical_networks(networks: &[VaultNetwork]) -> Vec<u8> {
    let mut output = b"neoos/custody/network-set/v1\0".to_vec();
    output.extend_from_slice(&(networks.len() as u32).to_be_bytes());
    for network in networks {
        push_field(&mut output, network.chain_family.as_bytes());
        output.extend_from_slice(&network.chain_id.to_be_bytes());
        push_field(&mut output, network.genesis_hash.as_bytes());
    }
    output
}

fn canonical_profile(profile: &VaultProfile, network_set_hash: &[u8; 32]) -> Vec<u8> {
    let mut output = b"neoos/custody/vault-profile/v1\0".to_vec();
    output.extend_from_slice(&profile.profile_version.to_be_bytes());
    push_field(&mut output, profile.vault_id.as_bytes());
    push_field(&mut output, profile.environment.as_bytes());
    output.extend_from_slice(network_set_hash);
    push_field(&mut output, profile.custody_kms_key_arn.as_bytes());
    push_field(&mut output, profile.root_key_version.as_bytes());
    push_field(&mut output, profile.root_key_commitment.as_bytes());
    output.extend_from_slice(&profile.snapshot_format_version.to_be_bytes());
    output.extend_from_slice(&profile.signer_schema_version.to_be_bytes());
    push_field(&mut output, profile.coordinator.origin.as_bytes());
    push_field(&mut output, profile.coordinator.aws_region.as_bytes());
    push_field(&mut output, profile.coordinator.snapshot_bucket.as_bytes());
    push_field(&mut output, profile.coordinator.snapshot_prefix.as_bytes());
    output.extend_from_slice(&(profile.coordinator.receipt_keys.len() as u32).to_be_bytes());
    for key in &profile.coordinator.receipt_keys {
        push_field(&mut output, key.key_id.as_bytes());
        push_field(&mut output, key.public_key_sec1_hex.as_bytes());
    }
    push_field(&mut output, profile.release_policy_version.as_bytes());
    output
}

#[cfg(test)]
pub(crate) fn test_profile(master_bytes: [u8; 32]) -> ValidatedVaultProfile {
    use p256::{elliptic_curve::sec1::ToSec1Point, SecretKey};

    let master = MasterKey::from_bytes(master_bytes);
    let receipt_key = SecretKey::from_slice(&[7; 32]).expect("fixed test receipt key");
    VaultProfile {
        profile_version: PROFILE_VERSION,
        vault_id: "00112233445566778899aabbccddeeff".to_string(),
        environment: "testnet".to_string(),
        networks: vec![
            VaultNetwork {
                chain_family: "neo-n3".to_string(),
                chain_id: 894_710_606,
                genesis_hash: format!("0x{}", "11".repeat(32)),
            },
            VaultNetwork {
                chain_family: "neox".to_string(),
                chain_id: 12_227_332,
                genesis_hash: format!("0x{}", "22".repeat(32)),
            },
        ],
        custody_kms_key_arn:
            "arn:aws:kms:us-east-1:736326664265:key/11111111-2222-3333-4444-555555555555"
                .to_string(),
        root_key_version: "testnet-r6".to_string(),
        root_key_commitment: hex::encode(root_key_commitment(&master)),
        snapshot_format_version: SNAPSHOT_FORMAT_VERSION,
        signer_schema_version: SIGNER_SCHEMA_VERSION,
        coordinator: CoordinatorProfile {
            origin: "https://custody-state-testnet.neoos.network".to_string(),
            aws_region: "us-east-1".to_string(),
            snapshot_bucket: "neoos-custody-state-testnet-736326664265".to_string(),
            snapshot_prefix: "vaults/testnet-r6".to_string(),
            receipt_keys: vec![ReceiptVerifierKey {
                key_id: "receipt-r1".to_string(),
                public_key_sec1_hex: hex::encode(
                    receipt_key.public_key().to_sec1_point(false).as_bytes(),
                ),
            }],
        },
        release_policy_version: "testnet-r6".to_string(),
    }
    .validate()
    .expect("fixed test vault profile")
}
