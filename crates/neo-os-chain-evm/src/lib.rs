//! neo-os-chain-evm — NeoX EVM chain adapter (T01 skeleton).
//!
//! Bodies arrive in T03, ported from `workers/morpheus-relayer/src/neox.js`:
//!
//! - `rpc` — EVM JSON-RPC over an injected transport (`eth_getLogs`,
//!   `eth_call`, `eth_sendRawTransaction`, receipt polling)
//! - `confidential` — confidential-envelope decoding (decode side only; the
//!   encryption authority is `neo-os-compute::oracle::crypto`, per
//!   docs/CRYPTO_OWNERSHIP.md)
//! - `fulfill` — fulfillment digest binding over the vector-locked
//!   `neo-os-core` digest builders
//! - `revert` — revert reason normalization that the relayer's failure
//!   classifier keys on
//!
//! Client library choice is settled: `alloy`, not `ethers-rs` (risk R9 — C
//! dependency would break the enclave's reproducible PCR build). Empty in T01.
