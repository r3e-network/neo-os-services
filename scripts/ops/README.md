# scripts/ops — operator runbooks-as-code

Manual ops scripts archived from `scripts/` root (2026-07-18 cleanup). They are
NOT wired into package.json or CI on purpose — operators run them by hand.
Each has zero references from live code (verified by grep at archive time).

- `fix-mainnet-morpheus-runtime.mjs` — mainnet runtime fix runbook
- `recover-and-rotate-admin.mjs` — read-only-by-default updater/verifier recovery using an
  already-confirmed CVM custody admin; see the safety contract below. This does not rotate the
  contract admin itself.
- `call-oracle-admin.mjs` — oracle admin calls; defaults to no-broadcast dry-run and requires
  explicit network, contract, admin, token, and rotation targets. `--apply` is mandatory for
  broadcast and enforces HTTPS endpoints.
- `fund-accounts.mjs` — account funding helper
- `quarantine-stale-relayer-jobs.mjs` — relayer job quarantine
- `generate-workspace-context-values.mjs` — superseded by `scripts/lib-workspace-validation-context.mjs`
- `backup-system-state.mjs` — DEPRECATED (targets the legacy Phala CVM; the `backup:system` npm alias was removed at archive time)

## `recover-and-rotate-admin.mjs` safety contract

This command builds exact `setUpdater` and `setOracleVerificationPublicKey` transactions for the
explicitly selected MorpheusOracle contract. It does not propose, execute, or finalize an admin
change. The existing on-chain admin must already be the CVM `worker` custody identity. Signing uses
the existing nitro-worker `POST /sign/payload` `data_hex` interface, not `/txproxy/invoke`; no
TxProxy allowlist change is needed or permitted by this runbook.

Every run requires an explicit `--network mainnet|testnet` and all of these non-empty environment
variables:

- `NEO_RPC_URL`, `NITRO_RUNTIME_URL`, and `CONTRACT_MORPHEUS_ORACLE_HASH`;
- `EXPECTED_ADMIN_ADDRESS` and `TARGET_ADMIN_ADDRESS` (each may be a Neo N3 address or a 20-byte
  `0x` script hash);
- at least one of `NEW_UPDATER_HASH` (non-zero address or `0x` script hash) and
  `NEW_VERIFIER_PUBLIC_KEY` (a valid compressed secp256r1 point, without `0x`).

`NITRO_API_TOKEN` is optional authentication for the CVM. `TX_CONFIRMATION_TIMEOUT_MS` and
`TX_POLL_INTERVAL_MS` control confirmation polling and otherwise default to 120000 ms and 2000 ms.
The command does not auto-load `.env` files or use production RPC, CVM, contract, admin, or target
defaults. Every non-loopback CVM endpoint must use HTTPS in every mode, including dry-run, because
derived-key requests can carry the shared bearer token. RPC endpoints must use HTTPS for apply;
loopback HTTP is reserved for local tests. Every CVM and RPC request uses `redirect: "error"`;
redirects are never followed.

Apply additionally requires explicit positive-int64 `MAX_SYSTEM_FEE`, `MAX_NETWORK_FEE`, and
`MAX_TOTAL_FEE` values, denominated in the chain's smallest fee unit (10^-8 GAS). These are operator
risk limits, not fee estimates, and have no defaults. Dry-run performs no fee simulation and does
not require them.

With no mode flag, or with `--dry-run`, the command only checks RPC `getversion`, queries CVM
`/keys/derived` for `worker` and `updater`, and reads the three safe getters with `invokefunction`.
It does not simulate, sign, broadcast, or write chain state. Derived responses have no mandatory
`network` field because nitro-worker does not return one. If a signer does return `network`, it must
match; absence is not treated as proof of network binding. Binding instead comes from the reviewed
RPC network magic, the exact network-magic transaction preimage, and the verified custody key.

The expected and target admin inputs must match each other, the CVM worker identity, and the
on-chain admin. Derived address, script hash, and public key must describe the same identity.
Address/hash and getter comparisons use canonical big-endian `0x` script hashes; 20-byte getter
`ByteString` values are decoded from little-endian bytes. Requested values equal to current values,
missing derived identities, malformed stack values, invalid public keys, or network mismatches fail
closed.

A write requires both `--apply` and an independent exact confirmation:

```sh
node scripts/ops/recover-and-rotate-admin.mjs \
  --network testnet --apply \
  --confirm-apply 'apply:testnet:0x<oracle-hash>:0x<current-admin-hash>'
```

Replace both placeholders with the full lowercase 20-byte (40-hex-character) hashes selected by
the environment; the confirmation must equal
`apply:<network>:<oracle-hash>:<expected-current-admin-hash>`. `--dry-run` and `--apply` are
mutually exclusive, and `--confirm-apply` is invalid without `--apply`.

Before any signing or broadcast, apply builds every requested transaction and completes all of
these preflights for each one:

1. Build the exact contract script, read `getblockcount`, and run `invokescript` with the expected
   admin as its only `CalledByEntry` signer. Any result other than `HALT` fails.
2. Set `systemFee` to the simulation's positive `gasconsumed`, rejecting anything above
   `MAX_SYSTEM_FEE`. Install the exact CheckSig placeholder witness, call `calculatenetworkfee`,
   and require its positive `networkfee` to be at most `MAX_NETWORK_FEE`. Missing, malformed, or
   failed fee responses fail; there is no default or fallback fee. The nonce comes from Node's
   cryptographic `randomInt`. Each transaction's combined fee and the BigInt sum of every planned
   transaction's fees must fit `MAX_TOTAL_FEE`; any excess or aggregate overflow is rejected before
   the first signing request. The confirmation log reports the planned total and its ceiling.
3. Construct `magic_le32 || SHA256(unsigned_tx)` and independently check it against Neon
   `getMessageForSigning`. The local txid is the reversed unsigned-transaction digest.

Each transaction then uses this signing request and `x-morpheus-network` header:

```json
{
  "target_chain": "neo_n3",
  "data_hex": "<exact-36-byte-preimage>",
  "use_derived_keys": true,
  "dstack_key_role": "worker"
}
```

The response must have matching `target_chain`, `source: "data_hex"`, and the SHA-256
`payload_hash` of those exact preimage bytes. Its signature must be 64 bytes; its public key must be
a valid secp256r1 point belonging to the expected admin; and its public key, address, and script
hash must all match the derived worker and expected admin. `wallet.verify` must verify the signature
over the exact preimage. The command then installs and deserializes the CheckSig witness and
rechecks the unsigned transaction, signer, scope, script, witness, preimage, and local txid before
broadcast.

Broadcast is RPC `sendrawtransaction` of that signed transaction. The returned `result.hash` must
equal the local txid. Confirmation requires the matching application log with exactly one
`Application` execution in `HALT`; faults, malformed responses, timeouts, and hash mismatches fail.
Finally, the command re-reads admin and all requested getters. A final mismatch is never success.

Transactions are signed, broadcast, and confirmed sequentially and are **not atomic**. Although all
simulation/fee preflights finish before the first signature, a later signing, broadcast, or
confirmation failure can leave earlier changes on-chain. Errors include confirmed method/txid pairs
for diagnosis; inspect them before retrying.

In particular, the current `contracts/MorpheusOracle/MorpheusOracle.cs` implementation makes
`setOracleVerificationPublicKey` a **timelock proposal**, while `setUpdater` is immediate. This
command does not wait for, bypass, or execute that timelock. Consequently, a dual apply can confirm
the updater and the verifier proposal, then must exit non-zero because the verifier getter has not
changed. That is not a successful dual rotation. Finalizing a mature proposal requires a separately
reviewed operational procedure.

The signer must support the exact nitro-worker `data_hex` preimage and response envelope above.
Deployments that only accept unsigned-transaction semantic signing, or that return a different
envelope, are not assumed compatible and require separate interface review. The repository's
current shipped posture classifies `sign_payload` as routed but retired (503). In addition, the
current Rust host in `workers/nitro-enclave-host/src/sign.rs` requires a complete unsigned
transaction for semantic signing and rejects this 36-byte `magic || txid` preimage; the host
response does not provide the required `target_chain`, `source`, and `payload_hash` envelope.
Enabling `ENCLAVE_ALLOW_BLIND_SIGN` would not make that deployment compatible. This command does
not enable any route or compatibility path. Before a production apply, the owner must separately
approve and verify an adapted signing deployment; local signing success is not evidence of
production compatibility. A single RPC can also fabricate confirmations and getter results, so
production success requires a trusted RPC or independent-node cross-confirmation.

The regression suite uses fixed synthetic private keys, real secp256r1 signatures, and mocked or
loopback HTTP only. It covers updater-only success, verifier proposal boundaries, partial failures,
fees, signatures, broadcast/confirmation validation, and redirect rejection:

```sh
node --test scripts/ops/recover-and-rotate-admin.test.mjs
```

These tests do not establish production custody, signer policy, endpoint support, fee sufficiency,
authorization, or rotation status. No production rotation is claimed by this runbook.
