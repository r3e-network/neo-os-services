//! Which chain a key signs for, and the value that goes into the preimage.
//!
//! This is the whole of the crate's dependency on chain identity. `neo-nexus`
//! kept the enum in `types` and the magic table in `config::format::network`;
//! the signer needs both and nothing else from either, so they live together
//! here and the crate depends on no other repository.

use std::{fmt, str::FromStr};

use anyhow::Result;

/// The blockchain family this signer operates on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChainFamily {
    /// Neo N3 (UTXO-like model, dBFT consensus)
    NeoN3,
    /// NeoX (EVM-compatible chain)
    NeoX,
}

impl ChainFamily {
    pub const ALL: [Self; 2] = [Self::NeoN3, Self::NeoX];
}

impl fmt::Display for ChainFamily {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::NeoN3 => "neo-n3",
            Self::NeoX => "neox",
        })
    }
}

impl FromStr for ChainFamily {
    type Err = anyhow::Error;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "neo-n3" | "n3" => Ok(Self::NeoN3),
            "neox" | "x" => Ok(Self::NeoX),
            other => anyhow::bail!("unsupported chain family: {other}"),
        }
    }
}

/// Network environment within a chain family.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Network {
    Mainnet,
    Testnet,
    Private,
}

impl Network {
    pub const ALL: [Self; 3] = [Self::Mainnet, Self::Testnet, Self::Private];
}

impl fmt::Display for Network {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Mainnet => "mainnet",
            Self::Testnet => "testnet",
            Self::Private => "private",
        })
    }
}

impl FromStr for Network {
    type Err = anyhow::Error;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "mainnet" => Ok(Self::Mainnet),
            "testnet" => Ok(Self::Testnet),
            "private" => Ok(Self::Private),
            other => anyhow::bail!("unsupported network: {other}"),
        }
    }
}

/// Chain identity for Neo N3. Crate-visible because signing is not the only code that
/// needs it: a witness preimage embeds the magic, so a second copy of this
/// table in the custody path is how one app ends up with keys that sign for two
/// different chains.
pub fn network_magic(network: Network) -> u32 {
    match network {
        Network::Mainnet | Network::Testnet => {
            neo_os_core::network_identity::known_neo_n3_identity(&network.to_string())
                .expect("known signer network must have a reviewed Neo N3 identity")
                .magic
        }
        Network::Private => 1_230_000,
    }
}

/// Chain ID for NeoX (EVM-compatible chain).
/// These are used in EIP-155 transaction signing.
pub fn neox_chain_id(network: Network) -> u64 {
    match network {
        Network::Mainnet | Network::Testnet => {
            neo_os_core::network_identity::known_neox_chain_id(&network.to_string())
                .expect("known signer network must have a reviewed NeoX identity")
        }
        Network::Private => 1337, // Local development
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn neox_public_chain_ids_match_the_published_networks() {
        assert_eq!(neox_chain_id(Network::Mainnet), 47_763);
        assert_eq!(neox_chain_id(Network::Testnet), 12_227_332);
    }
}

/// Complete chain specification including family and network.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChainSpec {
    pub family: ChainFamily,
    pub network: Network,
}

impl ChainSpec {
    pub const fn new(family: ChainFamily, network: Network) -> Self {
        Self { family, network }
    }

    /// Get the appropriate chain identifier for signing.
    /// For Neo N3, returns the network magic.
    /// For NeoX, returns the chain ID.
    pub fn chain_identifier(&self) -> u64 {
        match self.family {
            ChainFamily::NeoN3 => network_magic(self.network) as u64,
            ChainFamily::NeoX => neox_chain_id(self.network),
        }
    }
}

impl fmt::Display for ChainSpec {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}/{}", self.family, self.network)
    }
}

impl FromStr for ChainSpec {
    type Err = anyhow::Error;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let parts: Vec<&str> = value.split('/').collect();
        if parts.len() != 2 {
            anyhow::bail!("expected format: <chain-family>/<network>");
        }
        Ok(Self {
            family: parts[0].parse()?,
            network: parts[1].parse()?,
        })
    }
}
