//! Which chain a key signs for, and the value that goes into the preimage.
//!
//! This is the whole of the crate's dependency on chain identity. `neo-nexus`
//! kept the enum in `types` and the magic table in `config::format::network`;
//! the signer needs both and nothing else from either, so they live together
//! here and the crate depends on no other repository.

use std::{fmt, str::FromStr};

use anyhow::Result;

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

/// Chain identity. Crate-visible because signing is not the only code that
/// needs it: a witness preimage embeds the magic, so a second copy of this
/// table in the custody path is how one app ends up with keys that sign for two
/// different chains.
pub fn network_magic(network: Network) -> u32 {
    match network {
        Network::Mainnet => 860_833_102,
        Network::Testnet => 894_710_606,
        Network::Private => 1_230_000,
    }
}
