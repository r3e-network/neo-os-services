# Phase D — in-TEE EVM (secp256k1) signing for Neo X

**Goal (RC1):** every Neo X (EVM) signature the oracle produces is made _inside_ the
attested enclave with **no host-resident secp256k1 key** — the same guarantee Phase C
gave the X25519 oracle decryption key.

## Current state (what already holds)

- The enclave **already computes + signs EVM oracle FULFILLMENTS in-TEE.**
  `handleOracleFulfill`'s `chain==='neox'` branch builds the canonical keccak digest
  (`buildNeoXDigest`) and signs it (`signNeoXFulfillment`, EIP-191), returning
  `trust_tier:'enclave-attested'`. Proven by a byte-exact unit test
  (`enclave-server.test.mjs`, "neox: keccak digest + envelope + EIP-191 signature
  byte-exact").
- **GAP 2 (flag) is satisfied on the box:** `MORPHEUS_RELAYER_ENCLAVE_FULFILL=true`
  is set on the deployed relayer, and the flag is chain-agnostic — so the neox lane
  routes through `callEnclaveFulfill → POST /oracle/fulfill` (the relayer recomputes
  the digest as a cross-check) instead of host-side `signNeoXFulfillment`.

## GAP 1 — EVM verifier key via KMS attestation (CODE DONE + UNIT-TESTED)

The EVM verifier key was host-injected env (`MORPHEUS_NEOX_VERIFIER_PRIVATE_KEY`),
not KMS-attested like the X25519 key. Fixed by reusing the Phase C pattern verbatim:

- `enclave-server.mjs` `materializeNeoXVerifierKeyFromKms()` — mirrors
  `materializeOracleKeyFromKms()`: reads `MORPHEUS_NEOX_VERIFIER_KMS_CIPHERTEXT_BASE64`,
  short-circuits if a verifier key is already set (transition/rollback-safe), runs the
  **generic** `nsm-attest kms-decrypt` (no Go change — it decrypts any CMK ciphertext),
  and sets `MORPHEUS_NEOX_VERIFIER_PRIVATE_KEY` from the recovered plaintext (a raw
  `0x`-hex key or a JSON `{neox_verifier_private_key}` envelope). Called from
  `handleProvision()` right after `materializeOracleKeyFromKms()`.
- `provision-enclave-compute.sh` — injects ONLY the ciphertext
  (`/var/lib/morpheus/neox-verifier-kms.b64`, override via
  `MORPHEUS_NEOX_VERIFIER_KMS_CIPHERTEXT_PATH`); never the plaintext key. No-op when
  absent (EVM not enabled on this host).
- `enclave-server.test.mjs` — unit test stubs the attest runner and asserts the env
  var is set, the recovered key is a usable secp256k1 key (recovers to the expected
  address), idempotency, and the JSON-envelope form. `resolveNeoXConfig()` already
  reads exactly `MORPHEUS_NEOX_VERIFIER_PRIVATE_KEY`, so no other plumbing.

### Deploy / cutover steps for GAP 1 (NOT yet done — latent: no EVM key/traffic)

1. **[admin, AWS]** KMS-encrypt the EVM verifier secp256k1 key (raw `0x`-hex or
   `{neox_verifier_private_key}` JSON) under the **same** CMK
   `alias/morpheus-enclave-master` (key `5d9b6835…`, policy already gates
   `kms:Decrypt` on `kms:RecipientAttestation:ImageSha384 = <deployed EIF PCR0>`).
   Write the ciphertext to `/var/lib/morpheus/neox-verifier-kms.b64` on the box.
   - If the EIF PCR0 changes (new EIF below), update the key-policy PCR0 condition.
2. On the host, **blank the host verifier key** (`MORPHEUS_RELAYER_NEOX_VERIFIER_PK`
   unset) so host-side `signNeoXFulfillment` can never run; keep only the
   low-privilege updater/gas key (`fulfillNeoXRequest` just pays gas + submits the
   already-signed `fulfillRequest`, it cannot forge a verifier signature).
3. Rebuild + cut over the EIF (so the box runs `materializeNeoXVerifierKeyFromKms`),
   re-point the CMK PCR0 condition to the new PCR0, restart, **validate**: a neox
   `/oracle/fulfill` probe must return a signature that recovers to the KMS-materialized
   verifier address (a `"neox verifier private key is not configured"` / "key material
   unavailable" error means KMS failed) — same success criterion as the X25519 decrypt
   probe in `KMS-ATTESTATION-DESIGN.md`.
4. After validation: **rotate** the EVM verifier key (historically host-exposed),
   delete any host plaintext copy.

## GAP 3 — in-TEE EVM FEED signing (CODE DONE + UNIT-TESTED)

`MorpheusPriceFeed.updateFeeds` is authorized by `msg.sender` (an EOA tx), so unlike a
fulfillment there is no separable verifier signature — the enclave signs the **raw
EIP-1559 transaction**. Implemented (mirrors the Neo N3 reproducibility contract):

1. `enclave-server.mjs` `handleNeoXFeedSign()` (dispatched from `handleFeedSign` on
   `chain==='neox'`): fetches prices in-enclave, plans+scales the SAME way `pushNeoX`
   does (`planFeedUpdate`, 1e6 scale), builds the EIP-1559 `updateFeeds` tx from the
   host-pinned `tx_params` (to/chain_id/nonce/gas_limit/max[priority]\_fee_per_gas), and
   signs it with the KMS-materialized feed key (`MORPHEUS_NEOX_FEED_PRIVATE_KEY`).
   Returns the **signed serialized tx** + the plan arrays + the exact tx fields.
2. `feed-pusher.mjs` `pushNeoX` — added an enclave branch gated on
   `MORPHEUS_FEED_PUSHER_ENCLAVE_SIGN` **and** the new `NEOX_FEED_FROM` opt-in (the
   public feed EOA address; unset ⇒ the host-key path is used unchanged, so the box is
   unaffected until explicitly configured). It pins nonce (`getTransactionCount`) +
   fees (`getFeeData`) + `NEOX_FEED_GAS_LIMIT`, POSTs to the enclave `/feed/sign`, then
   `assertEnclaveNeoXTxMatches` parses the signed tx and **refuses to broadcast** unless
   to/chainId/nonce/from and the independently re-encoded calldata
   (`rebuildNeoXUpdateFeedsData`) all match (the EVM analogue of the Neo N3
   `tx_message_hex` assert), then `provider.broadcastTransaction`.
3. The feed EVM key moves to KMS attestation via `materializeNeoXFeedKeyFromKms()`
   (`MORPHEUS_NEOX_FEED_KMS_CIPHERTEXT_BASE64` → `MORPHEUS_NEOX_FEED_PRIVATE_KEY`), a
   distinct CMK ciphertext from the verifier key (least-privilege: feed-updater EOA ≠
   fulfill-verifier EOA), provisioned ciphertext-only by `provision-enclave-compute.sh`.

Tests: `enclave-server.test.mjs` (signed EIP-1559 tx recovers to the feed key + binds
the plan; neox tx_params validation) and `feed-pusher.test.mjs` (host re-encode +
fail-closed assert on to/chainId/nonce/from/calldata drift) — all green.

### Remaining for GAP 3 (latent — no EVM feed traffic on this box)

- **[admin, AWS]** KMS-encrypt the EVM **feed** key under the CMK → provision
  `/var/lib/morpheus/neox-feed-kms.b64` (the ciphertext-injection block already exists
  in `provision-enclave-compute.sh`; it is a no-op until the file is present).
- Set `NEOX_FEED_FROM` (the feed EOA address) on the host + drop the host `NEOX_FEED_PK`
  so the enclave path takes over and no EVM feed key remains on the host.
- EIF rebuild/cutover + on-chain `updateFeeds` validation.

## Also remaining

- **`deploy/evm/neox-fulfiller.mjs`** (standalone box fulfiller) independently signs the
  verifier digest host-side. Retire it once the systemd relayer runs enclave-fulfill for
  neox, or give it the same KMS treatment — otherwise it re-introduces the host-key
  exposure this phase closes.

> Status: GAP 1 (verifier key KMS) + GAP 3 (in-TEE EVM feed-sign) code + unit tests
> landed and green; GAP 2 flag already on. The remaining work is all latent (no EVM
> key/traffic on this box today): KMS-encrypt the verifier + feed keys, set
> `NEOX_FEED_FROM` + drop the host keys, EIF rebuild/cutover, and on-chain validation.
