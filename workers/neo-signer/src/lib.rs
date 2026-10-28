//! Signer service: custody chain-bound Neo N3 and NeoX private keys and produce
//! policy-guarded signatures for bearer or Ed25519 workload callers, with
//! optional origin restrictions.
//!
//! See `../../docs/SIGNER_SERVICE.md` for the ownership boundary and the HTTP
//! contract this crate implements. The module is organised so the signing path
//! never touches plaintext keys except inside [`crypto`], which returns
//! zeroized buffers.

pub mod api;
pub mod attestation;
pub mod attested_identity;
pub mod audit;
pub mod auth;
pub mod coordinator;
pub mod crypto;
pub mod durable;
pub mod embedded;
pub mod enrollment;
pub mod evm_tx;
pub mod legacy_material;
pub mod metrics;
pub mod model;
pub mod neo_block;
pub mod network;
pub mod policy;
pub mod provision;
pub mod service;
pub mod signclient;
pub mod snapshot;
pub mod store;
pub mod tx;
pub mod vault;
pub mod vault_profile;
