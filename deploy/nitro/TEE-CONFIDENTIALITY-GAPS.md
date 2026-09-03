# TEE confidentiality — gap map + remediation roadmap

**Goal (invariant):** all confidential computation and all signing run INSIDE the Nitro
enclave; no private key or confidential plaintext ever exists on the host or the edge.

**Source:** adversarial map 2026-06-15 (workflow wg25kfuea, 40 agents) →
28 confirmed gaps, updated by the 2026-09 production fail-closed audit.
Status: Neo N3 custody is in the current migration; the shipped Rust frontier
keeps confidential compute in-TEE, but the complete _EVM signing path_ is not
implemented in that measured runtime.

## ✅ Already in-TEE (verified clean)

- Oracle price aggregation, VRF, smart-fetch, `compute/execute` — run in the enclave worker bundle.
- X25519 decrypt **logic**, neodid nullifiers/tickets — run in the enclave.
- Encrypted-ref ciphertext fetch from Supabase — in-enclave over the egress proxy.
- Neo N3 signing — happens in-TEE in the recommended derived-keys topology.
- **Oracle X25519 key is KMS-attested in-TEE (2026-06-15).** Materialized in-enclave from a KMS
  ciphertext via `nsm-attest kms-decrypt` (fixed CMS BER parse, exec-9); host keystores shredded,
  zero host-resident confidential plaintext. See RC2.

## ✗ Gaps, by root cause

### RC1 — No shipped in-TEE EVM (secp256k1) signer (CRITICAL/HIGH)

The measured Rust frontier does **not** expose a complete Neo X signer:
`workers/nitro-enclave-host` returns `503` for Neo X `/oracle/fulfill` and
`/feed/sign`, and the Rust custody service currently stores Neo N3 P-256 keys
only. `crates/neo-os-compute` contains secp256k1 verification/recovery for the
message-reveal lane; that is not a signing or custody implementation.

The older Node `enclave-server.mjs` contains an EVM signing prototype and KMS
materialization code, but `Dockerfile.enclave` no longer ships Node. Those
tests are compatibility/golden vectors and must not be cited as evidence that
the production EIF can sign Neo X.

Without a production gate, the remaining EVM signatures are host-side:
relayer fulfillment (`neox.js`, `source: 'relayer_local_evm'`), relayer
transaction submission (`updaterSigner`), feed-pusher `pushNeoX`
(`NEOX_FEED_PK`), and `deploy/evm/neox-fulfiller.mjs`. Production now treats
that configuration as unavailable: activating the relayer Neo X lane or
supplying a host EVM private key fails before signing/broadcast. The feed
pusher exposes an explicit future enclave-route gate, but the current Rust EIF
returns `503` until a measured secp256k1 signer is shipped. Development can exercise the
legacy path only through an explicit unsafe opt-in. This closes the exposure by
disabling the lane; it does **not** claim Phase D is implemented.

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

**✓ Neo N3 signer keys — CLOSED by the custody migration (supersedes the
KMS-seal plan).** No runtime lane holds or reads `oracle_verifier`/`updater`
WIF material any more: relayer fulfillment, worker sign/tx-relay, feed-topup,
web control-plane relay, and NeoDID digest signatures all sign through the
custody signer service inside the enclave (`SIGNER_SERVICE_URL` +
`SIGNER_ROLE_*_KEY_ID`). Rendered runtime env files are WIF-free —
`check-nitro-env.mjs` treats an absent WIF as the healthy state and a
registry-mismatched leftover WIF as a hard failure. No
`materializeNeoN3RoleKeyFromKms` is needed.

### RC3 — CP-01 + custody migration (CLOSED)

The feed-lane leak was retired by CP-01; the `callback-broadcast` +
`automation-execute` workflow lanes were subsequently moved to the
custody-backed worker relay (no WIF is resolved from the edge env, forwarded
to the Vercel backend, or signed host-side — `apps/web` reads no signer env).

The authorization boundary is now separate too. `MORPHEUS_RUNTIME_TOKEN` is a
Nitro data-plane bearer and cannot authorize callback broadcast, feed tick,
automation execution, or control-plane job reads. Workflow, operator, and
relayer-operations callers use `MORPHEUS_WORKFLOW_API_KEY`,
`MORPHEUS_OPERATOR_API_KEY`, and `MORPHEUS_RELAYER_ADMIN_API_KEY`
respectively. A legacy runtime-token compatibility switch is development-only;
production ignores it.

### RC4 — Split / fallback topologies route confidential work off-TEE (HIGH/MEDIUM)

A standalone host `nitro-worker` (`server.js`, `morpheus-nitro-worker.service`, `:8788`) runs the
compatibility decrypt code on the host; if the relayer `apiUrl` points there, decrypt + the X25519
key run host-side. The Rust EIF now serves `/oracle/message-reveal` and the other declared
execution routes in-process. The remaining exposure is topology selection, not a missing route:
production confidential traffic must target the vsock-backed Rust endpoint, not the standalone
worker.

The relayer and web tier previously appended public-edge fallbacks
(`oracle.meshmini.app` / `edge.meshmini.app`) and attempted them in sequence.
Production confidential calls now require an explicit endpoint and attempt one
endpoint only. The public URLs remain valid explicit destinations for
non-confidential health/status/catalog probes; they are no longer synthesized
as confidential failover.

### RC5 — Host-side compute + signing fast-paths (MEDIUM)

Feed VALUE aggregation runs on the host then blind-signs in-TEE unless
`MORPHEUS_FEED_PUSHER_ENCLAVE_SIGN` is on. The relayer has a `resolveLocalVerifierAccount`
host-signing fast-path for Neo N3 that fires if any verifier key is in the relayer env. The
derived-keys path derives the Neo N3 key in host memory on the primary path.

## Remediation roadmap (each enclave-code phase = an EIF rebuild + cutover)

- **Phase A — routing/config (production gate complete; deployment validation remains):** turn on
  `MORPHEUS_RELAYER_ENCLAVE_FULFILL` (atomic decrypt+sign in-TEE) and
  `MORPHEUS_FEED_PUSHER_ENCLAVE_SIGN` (feed compute in-TEE); pin relayer
  `MORPHEUS_RUNTIME_URL/NITRO_API_URL` to the vsock bridge; production code now forces
  single-endpoint confidential routing and refuses synthesized public fallbacks. Decommission
  `morpheus-nitro-worker.service`; `/oracle/message-reveal` is already in the Rust route set and
  gateway. Before enabling enclave fulfillment for every request type, validate the migrated
  compute/oracle/NeoDID routes and keep session, VRF, automation, paymaster, feed, and zkLogin
  request types on the compatibility topology until their Rust adapters land.
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
- **Phase D — in-TEE EVM signing (RC1, NOT IMPLEMENTED in the shipped Rust EIF):** add a
  secp256k1 signing role to the Rust custody service/frontier; generate+seal
  the EVM verifier key in-TEE; route all Neo X feed + fulfillment signing through the enclave; keep
  only a low-privilege gas/submission key on the host (or move it in-TEE too).

## Honest framing

The user requirement "all computation secure + confidential inside the TEE" is
met for the current Rust confidential-compute lanes and Neo N3 custody
migration. It is **not** met for Neo X signing. The production guard makes that
gap fail closed by disabling host signing; completing Phase D still requires a
measured Rust secp256k1 custody/signing API, EIF rebuild, attestation/KMS policy
cutover, key rotation, and live on-chain validation.
