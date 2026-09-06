# TEE confidentiality — gap map + remediation roadmap

**Goal (invariant):** all confidential computation and all signing run INSIDE the Nitro
enclave; no private key or confidential plaintext ever exists on the host or the edge.

**Source:** adversarial map 2026-06-15 (workflow wg25kfuea, 40 agents) →
28 confirmed gaps, updated by the 2026-09 Rust custody and production-topology
cutover. Status: the current Rust frontier keeps confidential compute in-TEE,
and the separate measured Rust custody EIF implements both Neo N3/P-256 and
NeoX/secp256k1 signing. Deployment assurance still requires the matching EIF
measurements, KMS policy, and provisioned chain-bound roles.

## ✅ Already in-TEE (verified clean)

- Oracle price aggregation, VRF, smart-fetch, `compute/execute` — run in the enclave worker bundle.
- X25519 decrypt **logic**, neodid nullifiers/tickets — run in the enclave.
- Encrypted-ref ciphertext fetch from Supabase — in-enclave over the egress proxy.
- Neo N3 signing — happens in-TEE in the recommended derived-keys topology.
- NeoX EIP-1559 transaction and semantic EIP-191 fulfillment signing — happen
  in the separate Rust custody enclave under distinct updater and verifier roles.
- **Oracle X25519 key is KMS-attested in-TEE (2026-06-15).** Materialized in-enclave from a KMS
  ciphertext via `nsm-attest kms-decrypt` (fixed CMS BER parse, exec-9); host keystores shredded,
  zero host-resident confidential plaintext. See RC2.

## ✗ Gaps, by root cause

### RC1 — Rust custody-backed EVM (secp256k1) signer (CLOSED)

The production topology now separates the measured Rust frontier from the
measured Rust custody EIF. `neo-signer` stores immutable, chain-bound K256/NeoX
keys. `/sign/transaction` validates the requested family and chain ID and
returns the complete typed `signed_transaction`; `/sign/eip191-fulfillment`
accepts structured oracle semantics so callers cannot request an arbitrary
digest under the NeoX verifier role.

The frontier and relayer use separate `SIGNER_ROLE_NEOX_UPDATER_KEY_ID` and
`SIGNER_ROLE_NEOX_VERIFIER_KEY_ID` identities. Before accepting a custody
response, the frontier independently verifies the signed transaction's sender,
chain, digest, and calldata or recovers and checks the semantic signature's
public identity. Host-supplied EVM private keys remain forbidden in production.

The older Node `enclave-server.mjs` is compatibility/golden-vector evidence,
not an authority. The standalone `deploy/evm/neox-fulfiller.mjs` is
development-only and exits in production. The Node feed-pusher may still
schedule and broadcast a custody-signed transaction, but it neither receives
nor holds the NeoX private key.

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

**✓ NeoX signer keys — CLOSED by the same custody boundary.** Updater and
verifier are distinct K256 identities with immutable chain family and chain ID.
The updater returns complete signed EIP-1559 transactions; the verifier accepts
only the structured EIP-191 fulfillment contract. Neither role exposes private
material to the frontier, relayer, feed-pusher, or NeoNexus.

### RC3 — CP-01 + custody migration (CLOSED)

The feed-lane leak was retired by CP-01. The production callback authority is
the Rust relayer, while the control-plane callback route is retained only as a
manual recovery primitive. The control-plane automation route is currently a
no-op because the durable Rust automation scheduler is still fail-closed. No
WIF is resolved from the edge env, forwarded to the Vercel backend, or signed
host-side — `apps/web` reads no signer env.

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

### RC5 — Historical host-side signing fast-paths (CLOSED; compatibility risk remains)

The Rust authority has no local verifier account or private-key fallback. Feed
planning and signing use the measured `/feed/sign` path and custody roles; a
host-side pusher can only verify and broadcast the returned transaction.
Production validation rejects raw host signing keys. The residual risk is an
operator explicitly enabling a historical compatibility service, not a hidden
fallback inside the Rust frontier or relayer.

## Remediation roadmap (each enclave-code phase = an EIF rebuild + cutover)

- **Phase A — routing/config (production gate complete; deployment validation remains):** turn on
  `MORPHEUS_RELAYER_ENCLAVE_FULFILL` (atomic decrypt+sign in-TEE) and
  `MORPHEUS_FEED_PUSHER_ENCLAVE_SIGN` (feed compute in-TEE); pin relayer
  `MORPHEUS_RUNTIME_URL/NITRO_API_URL` to the vsock bridge; production code now forces
  single-endpoint confidential routing and refuses synthesized public fallbacks. Decommission
  `morpheus-nitro-worker.service`; `/oracle/message-reveal`, session, VRF,
  paymaster, feed observation, and zkLogin now have Rust adapters. Automation
  execution also has a Rust host adapter, but its separate durable scheduler and
  on-chain commit protocol remain disabled until they pass their own cutover gate.
- **Phase B — CP-01 (DONE):** callback broadcast is relayer-owned and the
  control-plane automation lane is disabled/no-op; neither path resolves or
  forwards a WIF. Historical host signer configuration must remain removed.
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
- **Phase D — in-TEE EVM signing (RC1, DONE in the current Rust artifacts):**
  chain-bound secp256k1 updater and verifier roles live in the separate custody
  EIF. NeoX feed and fulfillment signing use the semantic custody APIs, while
  the host/relayer independently validate every returned identity and signature
  before broadcast.

## Honest framing

The current Rust artifacts provide in-TEE confidential compute plus separate
Neo N3 and NeoX custody. This is a code and artifact property, not proof that an
arbitrary running host has the right release: production assurance still
depends on rebuilding and measuring both EIFs, pinning the matching PCR/KMS
policy, provisioning distinct chain-bound roles, rotating any historical
host-exposed keys, and validating the release on-chain.
