# Built-in Compute Functions

Morpheus Compute exposes built-in heavy functions through `POST /compute/execute`.

Current production architecture:

- control-plane ingress and orchestration stay outside the TEE
- confidential execution happens on the Oracle CVM
- mainnet and testnet share the same compute runtime and differ only by network metadata
- DataFeed publication does not share this execution lane

## Request Shape

```json
{
  "mode": "builtin",
  "function": "math.modexp",
  "input": {
    "base": "2",
    "exponent": "10",
    "modulus": "17"
  },
  "target_chain": "neo_n3"
}
```

## Script Registry References

If the inline script would make the request payload too large, you can store the script body in a Neo N3 contract getter and send only a small reference:

```json
{
  "mode": "script",
  "script_ref": {
    "contract_hash": "<production-script-registry-hash>",
    "method": "getScript",
    "script_name": "double"
  },
  "input": { "value": 7 },
  "target_chain": "neo_n3"
}
```

Rules:

- current supported chain for `script_ref` is `neo_n3`
- the contract getter must be read-only and return either `String` or `ByteString`
- the fetched script still passes the normal script-policy validator and timeout limits
- this reduces notification / payload pressure without bypassing the existing execution sandbox

## Available Built-ins

### `hash.sha256`

Hashes any JSON-serializable input.

### `hash.keccak256`

Keccak-256 digest for EVM-oriented preprocessing and cross-checks.

### `crypto.rsa_verify`

Verifies an RSA-SHA256 signature off-chain. RSA signature verification is computationally extremely expensive to execute natively within EVM or Neo N3 smart contracts.
Takes `public_key` (PEM text), `signature` (hex string), and `payload` (string). Returns `{"is_valid": true/false}`.

### `math.modexp`

Big integer modular exponentiation for cryptographic preprocessing.

### `math.polynomial`

Evaluates a polynomial of arbitrary degree ($c_n x^n + \dots + c_1 x + c_0$) off-chain. Especially useful when degrees are very large and gas costs would exceed block limits.
Takes `coefficients` (array of numbers from highest degree to constant $c_0$), `x` (number to evaluate at), and an optional `modulus`.

### `matrix.multiply`

Dense matrix multiplication.

### `vector.cosine_similarity`

Vector similarity scoring.

### `merkle.root`

Builds a SHA-256 Merkle root from a list of leaves.

### `zkp.public_signal_hash`

Normalizes and hashes a public signal set.

### `zkp.proof_digest`

Builds a deterministic digest of a proof object and optional verifying key context.

### `zkp.witness_digest`

Builds a deterministic digest of witness material before proving.

### `zkp.groth16.verify`

Verifies a Groth16 proof against a verifying key and normalized public signals.

### `zkp.groth16.prove.plan`

Returns a planning estimate for Groth16 proving workloads.

### `zkp.plonk.prove.plan`

Returns a planning estimate for PLONK proving workloads.

### `zkp.zerc20.single_withdraw.verify`

Validates zERC20 single-withdraw public inputs and can optionally verify a Groth16 proof for the same statement.
This helper is independent from the paymaster service. Applications may use it to preflight privacy-transaction proofs before submission or before requesting sponsorship.

### `fhe.batch_plan`

Returns a batching/packing plan based on slot and ciphertext counts.

### `fhe.noise_budget_estimate`

Returns a coarse planning estimate for FHE noise budget based on depth and modulus settings.

### `fhe.rotation_plan`

Returns a rotation/key-switch planning summary for vector index usage.

### `privacy.mask`

Masks a sensitive string, leaving edge characters visible (e.g. for partial logging in TEE).
Takes `value`, `unmasked_left` (default 2), and `unmasked_right` (default 2).

### `privacy.add_noise`

Adds simulated Laplace noise to a numeric value for differential privacy use cases.
Takes `value` and `scale` (default 1.0).

## Notes

These built-ins are the first production-facing layer of Morpheus Compute.
They are intentionally designed so that later Oracle runtime profiles can replace the internal implementation with real external ZKP / FHE engines while preserving the API surface.

Current runtime hardening also enforces:

- compute input size limits
- script / wasm result size limits
- worker timeouts for JS and WASM execution
