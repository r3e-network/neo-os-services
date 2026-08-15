# Morpheus Nitro Worker

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

## Key Endpoints

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

## Notes

- supports Neo N3
- accepts `encrypted_token` for auth secrets and encrypted JSON payload patches via `encrypted_params`, `encrypted_input`, or JSON-object `encrypted_payload`
- accepts `script` and `script_base64` as programmable compute aliases
- intended to run inside an AWS Nitro Enclave
- designed so multiple registered miniapps can share the same built-in module lanes instead of each deploying their own generic confidential runtime
- can emit Nitro (NSM) attestation documents when `NITRO_EMIT_ATTESTATION=true`
- can derive worker signing keys from AWS Secrets Manager when `NITRO_USE_DERIVED_KEYS=true`
- `src/server.js` provides the HTTP entrypoint for container/CVM deployment
- `Dockerfile` packages the worker for Nitro / CVM deployment
