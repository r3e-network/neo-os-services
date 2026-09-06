# Cryptographic Ownership

## Overview

NeoOS treats cryptography as a small set of explicitly owned protocol
boundaries. A primitive or wire format must have one Rust implementation, one
test-vector source, and one runtime owner. Compatibility JavaScript may verify
parity during migration, but it is not an alternative authority and it is not
included in a measured Rust Nitro image.

The ownership split is:

- `neo-os-core` owns deterministic consensus encoding, hashing, and envelope
  construction. It performs no key generation, key custody, encryption, or
  signing.
- `neo-os-compute::oracle::crypto` owns the oracle
  X25519-HKDF-SHA256-AES-256-GCM format, encrypted-reference claims, sealed
  oracle keystores, and oracle key-material resolution.
- `neo-signer::crypto` owns Neo N3 P-256 signatures, verification scripts,
  addresses, NEP-2 compatibility, and at-rest vault sealing. It deliberately
  exposes no WIF import surface. Private key bytes stay behind the signer
  service boundary.
- `nitro-attest` owns AWS Nitro attestation verification, KMS release
  protocols, and CMS envelope decryption.
- `nitro-enclave-host` composes these owners. It may hash data to bind an
  attestation or derive a domain-separated secret, but it must not carry a
  second protocol implementation.

## API Reference

### `neo_os_core`

- `sha256(bytes)` and `sha256_hex(bytes)` are the shared non-secret digest
  helpers.
- `digest`, `envelope`, `cbor`, `cose`, `neo_encoding`, and `n3_tx` define
  byte-exact protocol encodings.
- The crate must not depend on AES, elliptic-curve key agreement, password
  hashing, or signing crates.

### `neo_os_compute::oracle::crypto`

- `parse_configured_oracle_key_material` reads the supported configured X25519
  key representations.
- `parse_x25519_envelope` and `decrypt_x25519_envelope` implement the v2 oracle
  envelope.
- `resolve_confidential_payload` resolves, decrypts, and merges confidential
  request fields.
- `resolve_oracle_key_material` owns the configured, sealed, and development
  fallback decision tree.

Callers inject environment reads, network transport, file reads, key
derivation, and randomness. The module does not silently reach outside its
declared seams.

### `neo_signer::crypto`

- `sign_transaction` signs the Neo N3 network-magic transaction preimage.
- `sign_raw` is available only after the signer's independent raw-sign policy
  boundary allows it.
- `verification_script`, `script_hash`, and `address` derive the public Neo N3
  identity.
- `decrypt_nep2` and `encrypt_nep2` are import/export compatibility surfaces;
  unencrypted private keys are never returned by the service API.
- Base58Check encoding/validation uses the maintained `bs58` crate; the signer
  owns only Neo's version bytes and payload layout.

### `nitro_attest`

- Attestation document verification and KMS recipient binding live here.
- CMS AES/RSA operations are implementation details of KMS release and are not
  reusable application-level encryption APIs.

## Usage Examples

The enclave host consumes the canonical oracle implementation directly:

```rust
use neo_os_compute::oracle::crypto::{
    parse_configured_oracle_key_material, resolve_confidential_payload,
};

let key = parse_configured_oracle_key_material(env)?
    .ok_or("oracle key material unavailable")?;
let resolved = resolve_confidential_payload(payload, env, transport, &key)?;
```

Application services request Neo signatures from the signer API and never
import its private-key module:

```text
POST /signer/api/v1/sign/transaction
Authorization: Bearer <sign-only credential>

{"key_id":"key-...","request_id":"order-2026-09-02-42","unsigned_hex":"..."}
```

## Design Decisions

### One format, one implementation

The old `neo-os-core::confidential` module and
`neo-os-compute::oracle::crypto` both implemented the oracle v2 envelope.
`neo-os-compute` is the authority because it owns the complete lifecycle:
configured material, sealed keystores, encrypted references, decryption, and
payload merge semantics. The enclave host imports that implementation.

### Library primitives, protocol-owned composition

AES, HKDF, X25519, P-256, Ed25519, RSA, and scrypt come from maintained Rust
crates. Neo-specific preimages and oracle-specific domain separation remain in
their protocol owner and are pinned with external vectors. No service may add
an ad-hoc cipher, signature encoding, or key derivation.

### Custody is not a utility library

`neo-signer` deliberately does not expose private-key operations as a shared
crate. Other services use its authenticated API so policy checks, idempotency,
rate reservations, anti-equivocation, and audit writes cannot be bypassed.

### Compatibility code is not production authority

Node `crypto` calls under `workers/nitro-worker` remain migration fixtures only
until their consumers move to Rust. The measured Nitro Dockerfile must select
the Rust host and must not copy or launch that worker.

## Test Coverage

Changes to a cryptographic owner require:

1. external or legacy golden vectors for every changed wire format;
2. positive and negative verification tests, including malformed lengths and
   authentication failures;
3. parity tests at the consuming service boundary;
4. `cargo test --workspace` and `cargo clippy --workspace --all-targets`;
5. a dependency audit confirming that the removed implementation also removed
   its now-unused primitive dependencies.

`crates/neo-os-compute/tests/vectors/confidential-envelope-v2-client.json`
is the shared client-to-Rust decryption vector. Both the client encoder suite
and the Rust oracle owner must consume that same file; copying its values into
a second fixture is not sufficient parity evidence.

The minimum documentation coverage for cryptographic protocol owners is 100%:
every public cryptographic surface must be named in this document or in the
owner's paired service specification.
