# X25519 Confidential Payload Spec

Date: 2026-03-11

## Decision

Morpheus confidential payload transport is now defined as:

- `X25519-HKDF-SHA256-AES-256-GCM`

This is a full protocol replacement for the old RSA transport.
No backward-compatibility path is retained in the worker runtime.

## Goals

- keep the transport asymmetric
- reduce public-key and envelope size compared with RSA
- keep or improve classical security
- preserve the existing Oracle request / callback flow
- keep decryption exclusively inside the TEE

## Security Position

The new scheme uses:

- key agreement: `X25519`
- key derivation: `HKDF-SHA256`
- payload cipher: `AES-256-GCM`

Security comparison:

- `RSA-2048` is roughly `112-bit` classical security
- `X25519` is roughly `128-bit` classical security

Therefore the new transport is shorter and stronger than the old `RSA-2048` transport.

## Worker Public-Key API

`GET /oracle/public-key` now exposes:

```json
{
  "algorithm": "X25519-HKDF-SHA256-AES-256-GCM",
  "public_key": "<base64 32-byte raw public key>",
  "public_key_format": "raw",
  "key_source": "dstack-sealed",
  "recommended_payload_encryption": "X25519-HKDF-SHA256-AES-256-GCM",
  "supported_payload_encryption": ["X25519-HKDF-SHA256-AES-256-GCM"]
}
```

## Envelope Format

Confidential payloads are encoded as:

```json
{
  "v": 2,
  "alg": "X25519-HKDF-SHA256-AES-256-GCM",
  "epk": "<base64 ephemeral X25519 public key>",
  "iv": "<base64 12-byte AES-GCM nonce>",
  "ct": "<base64 ciphertext>",
  "tag": "<base64 16-byte GCM tag>"
}
```

Then the whole JSON object is UTF-8 encoded and base64 wrapped before being placed in:

- `encrypted_payload`
- `encrypted_params`
- `encrypted_input`
- `encrypted_token`

depending on the request type.

## Key Lifecycle

The worker stores one stable X25519 private key per deployment environment.

That key is:

- generated inside the Nitro worker runtime
- sealed with a KMS wrapping key (decrypted in-TEE via NSM attestation)
- stored at `NITRO_ORACLE_KEYSTORE_PATH`

The client does **not** know the worker private key.
Each client request instead creates a fresh ephemeral X25519 keypair locally.

So the server does not accumulate one decryption private key per user or per request.

## Browser Encryption Flow

1. fetch `/oracle/public-key`
2. import the raw X25519 public key
3. generate an ephemeral X25519 keypair in the browser
4. derive a shared secret with the worker public key
5. derive an AES-256-GCM key using HKDF-SHA256
6. encrypt the plaintext JSON payload
7. send only the envelope fields on-chain

## Worker Decryption Flow

1. parse the base64 envelope
2. import the sealed worker private key
3. import the sender ephemeral public key from `epk`
4. derive the same shared secret
5. derive the AES-256-GCM key with HKDF-SHA256
6. decrypt inside the TEE
7. merge the decrypted JSON patch into the request payload

## On-Chain Publication

The Oracle contracts continue to expose:

- `oracleEncryptionAlgorithm`
- `oracleEncryptionPublicKey`

They now store:

- algorithm string: `X25519-HKDF-SHA256-AES-256-GCM`
- public key string: raw X25519 public key encoded as base64

This fits within the existing contract storage shape and length bounds.

## Affected Components

The protocol cutover touches:

- browser helper:
  - [browser-encryption.ts](../apps/web/lib/browser-encryption.ts)
- worker key management and decryption:
  - [crypto.js](../workers/nitro-worker/src/oracle/crypto.js)
- worker public-key metadata:
  - [worker.js](../workers/nitro-worker/src/worker.js)
- example helpers:
  - [common.mjs](../examples/scripts/common.mjs)
- mainnet validation matrix:
  - [test-n3-privacy-matrix.mjs](../examples/scripts/test-n3-privacy-matrix.mjs)

## Mainnet Validation Scope

The mainnet validation set for the new scheme covers:

- builtin provider request with public params
- builtin provider request with encrypted params
- builtin compute request with encrypted payload
- custom compute script with encrypted payload
- custom URL Oracle request with encrypted params
- custom URL Oracle request with encrypted params plus custom JS function
- builtin provider request with encrypted params plus custom JS function

## Operational Rollout

Required sequence:

1. deploy worker runtime with X25519 support
2. verify `/oracle/public-key` returns the new algorithm and raw public key
3. publish the new public key on-chain with `setOracleEncryptionKey`
4. switch example/test clients to X25519 envelopes
5. run the mainnet privacy validation matrix

## Non-Goals

This migration does not provide post-quantum confidentiality.

If post-quantum encryption is required later, it should be treated as a separate protocol upgrade.
