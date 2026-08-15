# TEE confidentiality — gap map + remediation roadmap

**Goal (invariant):** all confidential computation and all signing run INSIDE the Nitro
enclave; no private key or confidential plaintext ever exists on the host or the edge.

**Source:** adversarial map 2026-06-15 (workflow wg25kfuea, 40 agents) →
28 confirmed gaps. Status: the confidential _compute_ is in-TEE; several _keys_ and the
whole _EVM path_ and two control-plane lanes are not.

## ✅ Already in-TEE (verified clean)

- Oracle price aggregation, VRF, smart-fetch, `compute/execute` — run in the enclave worker bundle.
- X25519 decrypt **logic**, neodid nullifiers/tickets — run in the enclave.
- Encrypted-ref ciphertext fetch from Supabase — in-enclave over the egress proxy.
- Neo N3 signing — happens in-TEE in the recommended derived-keys topology.
- **Oracle X25519 key is KMS-attested in-TEE (2026-06-15).** Materialized in-enclave from a KMS
  ciphertext via `nsm-attest kms-decrypt` (fixed CMS BER parse, exec-9); host keystores shredded,
  zero host-resident confidential plaintext. See RC2.

## ✗ Gaps, by root cause

### RC1 — No in-TEE EVM (secp256k1) signing → entire Neo X path is host-side (CRITICAL/HIGH)

The enclave `/sign/payload` signs secp256r1 (Neo N3) only. Every EVM key + signature is host-side:
relayer fulfillment (`neox.js signNeoXFulfillment`, `source:'relayer_local_evm'`), relayer tx
submission (`updaterSigner`), feed-pusher `pushNeoX` (`NEOX_FEED_PK` raw on host), the standalone
`deploy/evm/neox-fulfiller.mjs`, and `config.js:567-571` reading both EVM keys from host env. The
flag-gated in-enclave `/oracle/fulfill` EVM path exists but is OFF in prod and still reads the key
from host env (not sealed). The on-chain _verifier_ signature (forgeable oracle results) is the
confidential part and it signs on the host.

### RC2 — Keys are host-injected / host-unsealed, not enclave-born (PARTIALLY RESOLVED 2026-06-15)

**✅ Oracle X25519 decryption key — RESOLVED (KMS-attested, in-TEE, no host plaintext).** The
earlier hypothesis here — "the enclave's AWS SDK ignores `HTTPS_PROXY` so it can't reach KMS" — was
**WRONG**: the enclave reaches KMS fine over the egress proxy (verified: `egress_allowed
kms.us-east-1.amazonaws.com`), and KMS Decrypt + the attestation + the CMK policy all succeed. The
real blocker was that `nsm-attest` parsed the KMS `CiphertextForRecipient` CMS with Go
`encoding/asn1` (DER-only) while KMS returns **indefinite-length BER + a segmented `[0]` OCTET
STRING**, so every attestation-gated `kms-decrypt` died at the CMS parse and the key silently fell
back to a host keystore. Fixed in `deploy/nitro/nsm-attest/cms.go` (`berToDER` +
`concatOctetSegments`; exec-9, PCR0 `842f4f53…`). The oracle X25519 key is now KMS-materialized
**in-TEE** (`materializeOracleKeyFromKms` from `/var/lib/morpheus/oracle-key-kms.b64`, an
enclave-decrypt-only ciphertext); both host keystores were **shredded** — no host-resident
confidential plaintext remains. Published on-chain + round-trip validated.

**✗ Neo N3 signer keys — STILL host-injected (the remaining RC2 gap).** `oracle_verifier` +
`updater` are still plaintext in `morpheus-nitro-signer.env`
(`MORPHEUS_ORACLE_VERIFIER_WIF_MAINNET`/`_PRIVATE_KEY`, `MORPHEUS_UPDATER_NEO_N3_WIF_MAINNET`/
`_PRIVATE_KEY`) and injected via `/provision`. Now that in-TEE KMS decrypt works, seal them the same
way: add a generic `materializeNeoN3RoleKeyFromKms` (decrypt ciphertext → set the role WIF env the
signer reads), KMS-seal each WIF, provision the ciphertext instead of plaintext, drop the plaintext
env. The neodid salt + SM masters remain host-derivable.

### RC3 — CP-01 only partially fixed (CRITICAL)

The feed-lane leak was retired, but `callback-broadcast` + `automation-execute` workflow lanes
(`workflows-impl.js`) still resolve the Neo N3 WIF from the edge env and forward it to the Vercel
backend (`apps/web`), which signs Neo N3 txs host-side with neon-js. The WIF lives as a Cloudflare
edge secret + a Vercel env + signs on a non-TEE host.

### RC4 — Split / fallback topologies route confidential work off-TEE (HIGH/MEDIUM)

A standalone host `nitro-worker` (`server.js`, `morpheus-nitro-worker.service`, `:8788`) runs the
SAME decrypt code on the host; if the relayer `apiUrl` points there, decrypt + the X25519 key run
host-side. `/oracle/message-reveal` isn't in the enclave's route set (only the 6 execution routes +
sign/keys), so it's served by that host worker. The relayer also appends public-edge fallbacks
(`oracle.meshmini.app`/`edge`) to `apiUrl` with `allowFallback` default true → confidential compute
can be sent off-box if the local URL is unset.

### RC5 — Host-side compute + signing fast-paths (MEDIUM)

Feed VALUE aggregation runs on the host then blind-signs in-TEE unless
`MORPHEUS_FEED_PUSHER_ENCLAVE_SIGN` is on. The relayer has a `resolveLocalVerifierAccount`
host-signing fast-path for Neo N3 that fires if any verifier key is in the relayer env. The
derived-keys path derives the Neo N3 key in host memory on the primary path.

## Remediation roadmap (each enclave-code phase = an EIF rebuild + cutover)

- **Phase A — routing/config (lower risk, mostly flags/topology):** turn on
  `MORPHEUS_RELAYER_ENCLAVE_FULFILL` (atomic decrypt+sign in-TEE) and
  `MORPHEUS_FEED_PUSHER_ENCLAVE_SIGN` (feed compute in-TEE); pin relayer
  `MORPHEUS_RUNTIME_URL/NITRO_API_URL` to the vsock bridge and set `allowFallback:false` for
  decrypt/compute; decommission `morpheus-nitro-worker.service`; add `/oracle/message-reveal` to the
  enclave route set + gateway. Validate each.
- **Phase B — finish CP-01:** make `callback-broadcast` + `automation-execute` sign in-TEE (call the
  enclave `/sign/payload`), delete `resolveNeoN3*Signer` + the `...signer` spreads, remove the WIF
  from the control-plane + Vercel envs. Rotate that WIF (see RC3).
- **Phase C — enclave-self-sufficient key sealing (the structural fix for RC2):**
  - **DONE + committed (enclave-side foundation):** the enclave AWS SDK now egresses via the vsock
    proxy (`a90122b`), and `loadStableOracleKeyMaterial` unseals a ciphertext keystore from env
    (`b0a0cf5`, round-trip tested) — so the enclave can derive its own wrap key and unseal in-TEE.
  - **Remaining deployment (staged, each reversible):** (A) rebuild EIF with the above + cutover,
    keeping the host plaintext injection, and validate in-enclave that the SDK actually reaches
    Secrets Manager through the proxy (e.g. `/keys/derived`); (B) change `provision-enclave-compute.sh`
    to inject only the ciphertext keystore (+ stop deriving the neodid salt on host — the enclave
    now derives it), cutover, validate decrypt via in-TEE self-unseal; rollback = revert provision to
    plaintext (the new EIF still accepts it).
  - **⚠️ DECISION — partial vs complete.** The vsock-proxy approach removes the _routine_ host
    plaintext handling, but the host instance role + the on-disk keystore mean a host-root attacker
    can still re-derive the key. The COMPLETE "no key on host" guarantee needs **AWS KMS
    attestation-gated decrypt** (`kms:RecipientAttestation` bound to PCR0/1/2) so only the attested
    enclave can unwrap, plus scoping the EC2 instance role off the masters. That needs an AWS KMS key
    - IAM change (infra access + design decision).
  - **Rotate** the X25519 key after the switch (it was host-exposed) — with old-key retention for
    payloads already encrypted to the old pubkey.
- **Phase D — in-TEE EVM signing (RC1):** add a secp256k1 signing role to the enclave; generate+seal
  the EVM verifier key in-TEE; route all Neo X feed + fulfillment signing through the enclave; keep
  only a low-privilege gas/submission key on the host (or move it in-TEE too).

## Honest framing

The user requirement "all computation secure + confidential inside the TEE" is met for the
**compute**, but NOT for **key custody** (RC1/RC2) or two **signing lanes** (RC3), and is bypassable
in some **topologies** (RC4/RC5). Closing it fully = Phases A–D; the architectural core is Phase C
(enclave self-sufficiency so no key is ever host-unsealed) and Phase D (in-TEE EVM signing).
