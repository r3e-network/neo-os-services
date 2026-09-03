//! neo-os-relayer — orchestration shell (T01 skeleton).
//!
//! This crate restarts the relayer line after `morpheus-relayer-rs` was
//! confirmed dead (521 lines, seven phantom modules, unused napi bridge).
//!
//! What already exists elsewhere — do NOT re-implement here:
//! - consensus byte layer (kernel intents, fulfillment digests, result
//!   envelopes, compact callbacks): `neo-os-core`, vector-locked;
//! - Neo N3 / NeoX chain access: `neo-os-chain-n3` / `neo-os-chain-evm` (T03);
//! - signing: the `neo-signer` service over HTTP, never in-process keys;
//! - enclave calls: `nitro-enclave-host` over HTTP.
//!
//! What lands here (T02–T04), all state-machine logic testable without network:
//! - `config`: declarative schema, 109 keys / 149 env names, alias chains
//!   with documented precedence (env per-alias first, then
//!   `MORPHEUS_RUNTIME_CONFIG_JSON`), redaction marks (T02);
//! - `state`: on-disk state file (atomic tmp+rename writes), metric counters,
//!   retry scheduling with backoff and queue caps (T02);
//! - `scan`/`fulfill`: per-chain processing pipeline, fulfillment
//!   coordinator/dispatch/delivery (T04);
//! - `observe`: Prometheus exposition with byte-identical lines for the 25
//!   top-level counters and `chain|module|operation` labeled counters,
//!   JSON-line logs, Betterstack heartbeats (T04).
//!
//! External contracts this shell must keep byte-compatible are enumerated in
//! docs/rust-migration/ARCHITECTURE.md §5 — metric names, `/health` shape,
//! env alias precedence and CLI verbs are consumed by dashboards, alarms and
//! ops runbooks. Empty in T01; `main.rs` refuses to run until T04.
