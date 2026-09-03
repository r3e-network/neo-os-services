# Morpheus Compute

## Overview

`morpheus-compute` is the keyless Rust execution library used by the Nitro
enclave host. It ports deterministic compute, oracle-read, NeoDID, policy,
game, routing, and sandbox behavior from the legacy JavaScript worker while
keeping custody and HTTP serving outside the crate.

## API Reference

- `compute` and `standalone` execute bounded built-in, script, and WASM work.
- `oracle` validates providers, confidential envelopes, message reveal, and
  outbound fetch policy.
- `neodid` implements identity verification and ticket primitives.
- `game` contains deterministic game engines and parity codecs.
- `policy`, `permission`, `risk`, `overload`, and `circuit_breaker` expose
  fail-closed runtime guards.
- `capabilities` resolves the reviewed route surface.
- `transport` defines injected HTTP request/response and egress abstractions.

Public functions return plain Rust values or explicit errors. The
`nitro-enclave-host` crate owns authentication, route rendering, secrets,
custody calls, and process lifecycle.

## Usage Examples

```rust
use morpheus_compute::compute::execute_builtin_compute;
use serde_json::json;

let env = |_name: &str| None;
let result = execute_builtin_compute(
    &env,
    &json!({
        "function": "hash.sha256",
        "input": { "data": "hello" }
    }),
    &|| 0.5,
    &|_, _, _| Err("Groth16 CLI unavailable".to_string()),
)?;
```

Production callers use injected transports and environment readers supplied by
the enclave host; the library does not read private signing keys.

## Design Decisions

The JavaScript implementation remains the byte-level compatibility oracle.
Input limits, error order, number coercion, stable JSON ordering, and result
codecs are reproduced deliberately. Host I/O is injected so unit tests can
cover every policy branch without network access or process-global mutation.
No workspace crate depends on this package for custody: signing remains a
separate signer-service boundary.

## Test Coverage

`cargo test --workspace --all-targets` runs parity vectors, capability routing,
SSRF policy, sandbox limits, compute/game behavior, and enclave-host
integration. `cargo clippy --workspace --all-targets -- -D warnings` and
`cargo fmt --all -- --check` are required quality gates.
