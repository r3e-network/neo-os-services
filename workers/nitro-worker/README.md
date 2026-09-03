# Morpheus Nitro Worker

## Overview

This worker is the trusted execution core of **NeoOS Services**.

The public endpoint names still use some legacy oracle-shaped paths, but the intended runtime
model is a shared MiniApp OS execution plane serving built-in module lanes for many miniapps.

## Built-In Module Lanes

- `oracle` — shared fetch/query lane plus programmable transformations
- `compute` — built-in heavy compute lane and script execution
- `feeds` — shared numeric resource publication/read lane
- `vrf` — randomness lane
- `sign` — chain-aware signing helpers
- `relay` — Neo N3 relay helpers

## Built-in Compute Functions

Inspect the live catalog via `GET /compute/functions`.
Current built-ins cover hashing, RSA verification, modular arithmetic, polynomial evaluation, matrices, vector similarity, Merkle roots, ZKP planning/digests, FHE planning, and privacy helpers.

## API Reference

- `GET /health`
- `GET /info`
- `GET /attestation`
- `GET /keys/derived`
- `GET /oracle/public-key`
- `POST /oracle/query`
- `POST /oracle/smart-fetch`
- `GET /compute/functions`
- `POST /compute/execute`
- `GET /feeds/price/:symbol`
- `POST /vrf/random`
- `POST /sign/payload`
- `POST /relay/transaction`

## Usage Examples

Use `GET /health` for readiness and `GET /compute/functions` to discover the
measured runtime's supported compute surface. Signing and transaction relay
require a provisioned custody key ID and signer-service connection; requests
fail closed when either is absent.

## Design Decisions

The worker never derives or accepts production Neo N3 private keys. Result
envelopes and relay transactions are signed by the custody signer service under
role-specific key grants. Test code uses the same custody client through an
in-memory transport seam, so missing test provisioning cannot accidentally
reopen local signing.

## Test Coverage

`npm run test:worker` covers route authorization, confidential payload handling,
game-session result signing, custody refusals, replay protection, and worker
lane behavior. Rust enclave-host and signer tests run separately through
`cargo test --workspace --all-targets`.

## Notes

- supports Neo N3
- accepts `encrypted_token` for auth secrets and encrypted JSON payload patches via `encrypted_params`, `encrypted_input`, or JSON-object `encrypted_payload`
- accepts `script` and `script_base64` as programmable compute aliases
- intended to run inside an AWS Nitro Enclave
- designed so multiple registered miniapps can share the same built-in module lanes instead of each deploying their own generic confidential runtime
- can emit Nitro (NSM) attestation documents when `NITRO_EMIT_ATTESTATION=true`
- obtains Neo N3 signatures from the custody signer service; no production
  worker private key is loaded into the JavaScript runtime
- `src/server.js` provides the HTTP entrypoint for container/CVM deployment
- `Dockerfile` packages the worker for Nitro / CVM deployment
