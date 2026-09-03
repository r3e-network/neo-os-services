//! Signer service: custody Neo N3 private keys and produce policy-guarded
//! signatures for callers authenticated by token and, optionally, origin URL.
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
pub mod crypto;
pub mod evm_tx;
pub mod model;
pub mod network;
pub mod policy;
pub mod provision;
pub mod service;
pub mod store;
pub mod tx;
pub mod vault;
