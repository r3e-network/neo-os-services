# RC3 — Control-Plane Signing Lane Migration into the TEE

**Status:** DRAFT — design proposal
**Severity:** CRITICAL (per `TEE-CONFIDENTIALITY-GAPS.md`, RC3)
**Owner:** Oracle infrastructure
**Related:** `KMS-ATTESTATION-DESIGN.md` (Phase C, deployed 2026-06-15),
`TEE-CONFIDENTIALITY-GAPS.md`, `AA-EDGE-MIGRATION-RUNBOOK.md`,
`PHASE-D-EVM-IN-TEE.md`

---

## 1. Problem Statement

### 1.1 What RC3 is

RC3 is the residual gap left by the partial CP-01 fix. The feed-lane WIF leak was
retired, but the two **control-plane fulfillment lanes** —

- `callback-broadcast` (`morpheus-callback-broadcast-workflow`)
- `automation-execute` (`morpheus-automation-execute-workflow`)

— still produce their Neo N3 fulfillment signatures **outside the measured enclave
boundary**. The Cloudflare Workflow lane resolves a Neo N3 WIF from edge env (or
forwards it to the Vercel `apps/web` backend, which resolves the WIF from its own
process env) and signs the on-chain fulfillment transaction with neon-js on a
non-TEE host (Cloudflare edge isolate or Vercel Node runtime).

### 1.2 Why it is rated CRITICAL

The system invariant (see `TEE-CONFIDENTIALITY-GAPS.md`) is:

> All confidential computation **and all signing** run INSIDE the Nitro enclave; no
> private key or confidential plaintext ever exists on the host or the edge.

RC3 violates the second clause for the two lanes that finalize oracle requests
on-chain. The `oracle_verifier` and `updater` Neo N3 signer keys are the keys whose
signatures the on-chain kernel/registry contracts trust. A signature from these keys
is indistinguishable from an attested enclave signature — so any party that can read
the WIF can forge oracle fulfillments (wrong results, false successes, replayed
automation dispatches) with full on-chain validity.

### 1.3 Attack surface created by RC3

| Vector                                          | Exposure                                                                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare edge secret store / dashboard access | WIF readable by anyone with the worker's secret-edit permission                                                                             |
| Cloudflare isolate memory                       | WIF in plaintext for the lifetime of the workflow step                                                                                      |
| Vercel env (`apps/web`)                         | WIF in plaintext in the Next.js process env; readable by anyone with Vercel project access or a runtime RCE in `apps/web`                   |
| Vercel build / preview deploys                  | Env vars replicated to non-prod preview URLs                                                                                                |
| Workflow retry logs                             | `step.do` retries can persist request bodies in Cloudflare's workflow history                                                               |
| Host compromise of the CVM                      | Does NOT help the attacker today, but the WIF lives on three other platforms anyway — the TEE boundary is bypassed entirely for these lanes |

The relayer's primary request path already signs fulfillments inside the TEE
(`MORPHEUS_RELAYER_ENCLAVE_FULFILL`, `/oracle/fulfill`), so RC3 is the **only**
remaining lane where a Neo N3 fulfillment signature is produced off-TEE. Closing it
makes the invariant true for Neo N3.

---

## 2. Current Architecture

### 2.1 Lane flow today

```
                Cloudflare edge (non-TEE)                  Vercel (non-TEE)
   ┌────────────────────────────────────────────┐    ┌──────────────────────────────┐
   │  morpheus-control-plane worker             │    │  apps/web (Next.js)          │
   │                                            │    │                              │
   │  CallbackBroadcastWorkflow.run()           │    │  /api/internal/control-plane │
   │   └─ step.do(callAppBackend(               │    │   /callback-broadcast        │
   │        '/api/internal/control-plane/       │    │     │                        │
   │         callback-broadcast', body))        │ ─► │     ├─ resolve updater WIF   │
   │                                            │    │     │  from process.env      │
   │  AutomationExecuteWorkflow.run()           │    │     ├─ neon-js sign          │
   │   └─ step.do(callAppBackend(               │    │     │  (host memory)         │
   │        '/api/internal/control-plane/       │ ─► │     └─ sendRawTransaction    │
   │         automation-execute', body))        │    │        → Neo N3 RPC          │
   └────────────────────────────────────────────┘    └──────────────────────────────┘
                  ▲                                                │
                  │ MORPHEUS_UPDATER_NEO_N3_WIF_*                  ▼
                  │ MORPHEUS_RELAYER_NEO_N3_WIF_*           Neo N3 mainnet/testnet
                  │ (edge secret, partially retired)
                  │
        (legacy path — already removed from the edge by CP-01,
         but the WIF still lives in the Vercel env and signs there)
```

### 2.2 Where the WIF lives today

- `apps/web` process env: `MORPHEUS_UPDATER_NEO_N3_WIF_<NET>`,
  `MORPHEUS_RELAYER_NEO_N3_WIF_<NET>` (resolved by
  `apps/web/lib/neo-control-plane.ts → createNeoN3Account`).
- Cloudflare edge env: `MORPHEUS_UPDATER_NEO_N3_WIF_*` /
  `MORPHEUS_RELAYER_NEO_N3_WIF_*` — partially retired by CP-01 (the workflow no
  longer forwards the WIF in the body), but the names are still present in
  `vars.example.env` / `wrangler.example.toml` and the
  `resolveNeoN3*Signer` helpers in `lib/execution-plane.js` still exist.
- CVM (the good copy): the same `oracle_verifier` + `updater` keys are provisioned
  into the enclave via `/provision` and used by `/sign/payload`, `/keys/derived`,
  and `/oracle/fulfill` — but only for the relayer's primary request path.

### 2.3 What is already in-TEE (and reusable)

- `enclave-server.mjs` exposes `/sign/payload` (blind-sign caller-supplied
  `data_hex` with a pinned role key) and `/keys/derived` (public identity only).
- `/oracle/fulfill` performs atomic compute+sign for the relayer's primary path.
- The X25519 oracle decryption key is **KMS-attested in-TEE** (Phase C, deployed):
  the host provisions only the CMK ciphertext
  (`/var/lib/morpheus/oracle-key-kms.b64`); the enclave materializes the key via
  `nsm-attest kms-decrypt` → `materializeOracleKeyFromKms`; the CMK policy
  (`alias/morpheus-enclave-master`) gates `kms:Decrypt` on
  `kms:RecipientAttestation:ImageSha384 = <PCR0>`.
- The relayer already calls the enclave over vsock for the primary path; the
  Cloudflare control plane already reaches the box via
  `https://runtime.meshmini.app/{net}` (auth-gated, 6 execution routes only).

---

## 3. Target Architecture

All Neo N3 signing for `callback-broadcast` and `automation-execute` must be
performed inside the attested enclave, by the same `oracle_verifier` / `updater`
keys that are already pinned there. Three options were considered.

### 3.1 Option A — Cloudflare Workflow calls the CVM signing endpoint (vsock-proxied)

The workflow keeps its current shape but, instead of `callAppBackend(...)`, calls a
new enclave route `POST /sign/n3` on `runtime.meshmini.app/{net}` (the existing
auth-gated gateway). The enclave signs and returns the signed tx (or the signature);
the workflow (or a thin broadcast helper) submits to the Neo N3 RPC.

```
Cloudflare Workflow ──HTTPS──► runtime.meshmini.app ──► nginx ──► vsock ──► enclave
                                                                              │
                                                                  POST /sign/n3
                                                                  (sign with pinned
                                                                   updater key)
```

- **Pros:** minimal change to the workflow; reuses the existing public gateway.
- **Cons:** the workflow still owns broadcast + nonce management; the signing
  endpoint becomes a public (token-gated) surface; the WIF still has to be
  provisioned into the enclave somehow (today: host-injected plaintext via
  `/provision` — does not fix RC2 for these keys).

### 3.2 Option B — Move workflow execution into the relayer

Re-implement `callback-broadcast` and `automation-execute` as relayer jobs (the
relayer already runs in-TEE-adjacent and signs fulfillments via `/oracle/fulfill`).
The Cloudflare workflow becomes a thin trigger that enqueues a relayer job.

- **Pros:** consolidates all signing in one place; lets the relayer's existing
  attested-fulfill path cover these lanes.
- **Cons:** large refactor (workflow state, retries, DLQs, idempotency all move);
  the relayer's signing path still reads the WIF from host env unless RC2 is also
  fixed; couples two control-plane lanes to relayer availability.

### 3.3 Option C — KMS-attested key release for the N3 signer key inside the CVM,

then route workflow signing requests to the CVM

Extend the **already-deployed Phase C KMS pattern** to the Neo N3 signer keys:

1. KMS-seal each N3 signer WIF under `alias/morpheus-enclave-master` (same CMK,
   same PCR0 attestation condition).
2. Provision only the **ciphertext** to the CVM
   (`/var/lib/morpheus/n3-signer-kms.b64` per role).
3. The enclave materializes the WIF in-TEE via a generic
   `materializeNeoN3RoleKeyFromKms` (decrypt ciphertext → set the role WIF env the
   signer reads), exactly mirroring `materializeOracleKeyFromKms`.
4. Add a `POST /sign/n3` endpoint to the nitro-worker / enclave-server that signs
   arbitrary Neo N3 transactions with the pinned role key.
5. Migrate the two workflow lanes to call `/sign/n3` (Option A's call shape) —
   the WIF never exists on the edge or on Vercel.

```
            ┌──────────────────────────────────────────────────────────────┐
            │                       AWS Nitro CVM                          │
            │                                                              │
            │   ┌──────────────────────── enclave ─────────────────────┐   │
            │   │                                                      │   │
            │   │  /var/lib/morpheus/n3-signer-kms.b64  (ciphertext)   │   │
            │   │           │                                          │   │
            │   │           ▼  nsm-attest kms-decrypt                  │   │
            │   │           │  (attestation gated on PCR0)             │   │
            │   │           ▼                                          │   │
            │   │   materializeNeoN3RoleKeyFromKms()                   │   │
            │   │           │                                          │   │
            │   │           ▼                                          │   │
            │   │   pinned oracle_verifier / updater WIF (in-TEE only) │   │
            │   │           │                                          │   │
            │   │           ▼                                          │   │
            │   │   POST /sign/n3  ◄────── vsock ◄────── nginx ◄── CF  │   │
            │   │   (sign tx, return signed tx + signature)            │   │
            │   └──────────────────────────────────────────────────────┘   │
            └──────────────────────────────────────────────────────────────┘
                                          │
                                          ▼
                                  Neo N3 mainnet/testnet
```

- **Pros:**
  - Extends a **deployed, end-to-end-validated** pattern (Phase C). No new AWS
    infra: same CMK, same attestation condition, same `nsm-attest kms-decrypt`
    binary (CMS-BER fix already in).
  - Closes RC2 for the N3 signer keys at the same time (no host-injected
    plaintext WIF; the host provisions only ciphertext).
  - Minimal new code: one new materializer + one new route + workflow call-site
    swap.
  - The signing endpoint can be token-gated and rate-limited like the existing
    execution routes.
- **Cons:**
  - Requires an EIF rebuild (new PCR0) and a CMK key-policy update to the new
    PCR0 — same chicken-and-egg sequence as Phase C, already documented.
  - The Cloudflare workflow still owns broadcast/nonce; acceptable because
    broadcast is non-confidential.

---

## 4. Recommended Approach

**Option C.**

Rationale:

1. **It is the smallest delta from a deployed, validated state.** Phase C proved
   the KMS-attested release pattern end-to-end for the X25519 key (EIF
   `oracle-enclave-exec-2026-06-15.9`, PCR0 `842f4f53…`, CMK
   `alias/morpheus-enclave-master`). Re-using it for the N3 signer keys is a
   generalization, not a new design.
2. **It closes RC2 and RC3 together.** The N3 signer keys are the remaining RC2
   gap (`TEE-CONFIDENTIALITY-GAPS.md`, RC2). Option C removes the host-injected
   plaintext WIF for `oracle_verifier` + `updater` while moving the two
   control-plane signing lanes in-TEE.
3. **Minimal new infrastructure.** No new CMK, no new IAM, no new gateway. The
   only AWS-side change is a key-policy PCR0 update (and optionally a second
   statement scoped to the same condition).
4. **Option B's consolidation is desirable but orthogonal** — it can be done
   later, on top of Option C, once the relayer's own signing path is also
   KMS-attested.

---

## 5. Implementation Plan

Each phase is independently deployable and reversible. Phases 1–2 are enclave-side
(no workflow change); phases 3–4 are workflow-side; phase 5 is the cleanup +
rotation.

### Phase 1 — Provision the N3 signer key via KMS-attested release into the CVM

**Goal:** the enclave materializes `oracle_verifier` and `updater` WIFs from KMS
ciphertext, mirroring the X25519 key. Host plaintext injection remains as a
fallback during this phase.

- Add `materializeNeoN3RoleKeyFromKms(role, ciphertextPath)` to
  `enclave-server.mjs`, modeled on `materializeOracleKeyFromKms`:
  - read `/var/lib/morpheus/n3-signer-<role>-kms.b64` (ciphertext only);
  - call `nsm-attest kms-decrypt` (CMS-BER fix already in `cms.go`);
  - on success, set the role WIF env var the signer already reads
    (`MORPHEUS_ORACLE_VERIFIER_WIF_<NET>` / `MORPHEUS_UPDATER_NEO_N3_WIF_<NET>`)
    and clear the memoized signer cache (the existing cache-clear on env mutation
    already covers this);
  - record `key_source: 'kms_attested'` for `/health`.
- Wire it into the startup materialization order, **before** the host-injected
  plaintext path (so KMS wins when the ciphertext is present).
- KMS-seal each WIF under `alias/morpheus-enclave-master` (admin):
  `aws kms encrypt --key-id alias/morpheus-enclave-master --plaintext <wif>`.
- Provision the ciphertexts to the CVM
  (`/var/lib/morpheus/n3-signer-oracle_verifier-kms.b64`,
  `/var/lib/morpheus/n3-signer-updater-kms.b64`).
- **Validation:** `/health` reports both roles with `key_source: 'kms_attested'`;
  `/keys/derived` returns the same pinned identities as before
  (`oracle_verifier` `03399c42…` unchanged); a `/sign/payload` round-trip
  verifies against the on-chain identity.
- **Rollback:** `rm /var/lib/morpheus/n3-signer-*-kms.b64` + restart → the
  existing host-plaintext path takes over (same rollback shape as Phase C).

### Phase 2 — Add `POST /sign/n3` to the nitro-worker / enclave-server

**Goal:** a generic, auth-gated endpoint that signs an arbitrary Neo N3
transaction with a pinned role key and returns the signed transaction.

- Route: `POST /sign/n3` (and `POST /{network}/sign/n3` for the gateway-prefixed
  form), added to the enclave route set in `enclave-server.mjs` next to
  `/sign/payload`.
- Request:
  ```json
  {
    "role": "updater" | "oracle_verifier",
    "network": "mainnet" | "testnet",
    "tx_hex": "<unsigned Neo N3 transaction, hex>",
    "sign_only": false
  }
  ```
- Behavior:
  - reject if `role` is not pinned or the materialized identity does not match
    the pinned identity (`reportPinnedNeoN3Role`, same as `/sign/payload`);
  - decode `tx_hex`, compute the Neo N3 transaction signing digest, sign with the
    pinned role key (reuse `signNeoN3OracleVerifier` / the cached neon account);
  - if `sign_only: true`, return `{ signature_hex, public_key, script_hash }`;
  - otherwise attach the witness and return `{ signed_tx_hex, txid, signature_hex }`.
- Auth: same `MORPHEUS_RUNTIME_TOKEN` / `NITRO_API_TOKEN` bearer gate as the
  other execution routes; the gateway (`runtime-gateway.nginx.conf`) is widened
  to allow `/sign/n3` only (no other new routes).
- Rate limiting: per-token bucket at the gateway (see §6.3).
- **Validation:** unit test (sign a known tx, verify the witness against the
  pinned pubkey); integration test through the gateway with a testnet tx.
- **Rollback:** the route is additive; removing it from the route set + gateway
  reverts.

### Phase 3 — Migrate `callback-broadcast` to call the CVM signing endpoint

**Goal:** the workflow no longer triggers a Vercel-side host signing; the
fulfillment signature comes from the enclave.

- Add a `callEnclaveSignN3(env, network, body)` helper to
  `deploy/cloudflare/morpheus-control-plane/lib/execution-plane.js` that POSTs to
  `${MORPHEUS_${NET}_EXECUTION_BASE_URL}/sign/n3` with the execution token.
- In `CallbackBroadcastWorkflow.run()`, replace the
  `callAppBackend('/api/internal/control-plane/callback-broadcast', …)` step with:
  1. `step.do('build callback tx', …)` — assemble the unsigned fulfillment tx
     (reuse the existing builder in `apps/web/lib/neo-control-plane.ts`, factored
     into a shared package so the workflow can call it without the WIF);
  2. `step.do('sign callback tx in TEE', …)` — `callEnclaveSignN3(...)`;
  3. `step.do('broadcast signed tx', …)` — submit `signed_tx_hex` to the Neo N3
     RPC (non-confidential; can run from the workflow or a thin broadcast
     helper).
- Keep the Vercel `/api/internal/control-plane/callback-broadcast` route live
  during this phase as the rollback path (feature-flagged off by default once
  the workflow path is validated).
- **Validation:** end-to-end testnet callback broadcast where the on-chain
  witness verifies against the enclave's pinned `updater` identity; the workflow
  logs `key_source: 'kms_attested'` echoed by `/sign/n3`.
- **Rollback:** flip the feature flag back to `callAppBackend(...)` (Vercel
  host-signing path); alerting unchanged.

### Phase 4 — Migrate `automation-execute`

**Goal:** same as Phase 3, for the automation lane.

- The automation route already rejects raw signer material in the body
  (`hasRawSignerMaterial` in `automation-execute/route.ts`), so the workflow side
  is the only change.
- Replace `callAppBackend('/api/internal/control-plane/automation-execute', …)`
  with the same build → `/sign/n3` → broadcast sequence, using the automation
  dispatch builder (`buildUpkeepDispatch` / `buildUpkeepExecutionPayload`,
  already in `@r3e-network/neo-os-services-shared/automation-supervisor`).
- Idempotency: carry the existing `idempotency_key` / `replay_window` into the
  `/sign/n3` request so the enclave can dedupe (see §6.2).
- **Validation:** testnet automation run with the on-chain witness verifying
  against the pinned identity; replay of the same `idempotency_key` is rejected.
- **Rollback:** same feature-flag pattern as Phase 3.

### Phase 5 — Remove the WIF from edge + Vercel envs, rotate keys

**Goal:** no plaintext N3 signer WIF exists outside the enclave; the
historically-exposed WIF is rotated.

- Delete `resolveNeoN3BackendSigner` / `resolveNeoN3FeedSigner` and the
  `...signer` spreads from
  `deploy/cloudflare/morpheus-control-plane/lib/execution-plane.js`.
- Remove `MORPHEUS_UPDATER_NEO_N3_WIF_*` / `MORPHEUS_RELAYER_NEO_N3_WIF_*` from
  `vars.example.env`, `wrangler.example.toml`, and the live Cloudflare secrets
  (`wrangler secret delete`).
- Remove `createNeoN3Account`'s env-WIF resolution from
  `apps/web/lib/neo-control-plane.ts`; delete the Vercel env vars; retire the
  `/api/internal/control-plane/callback-broadcast` +
  `/automation-execute` host-signing code paths (or leave them as 410 Gone
  tombstones for one release).
- Remove the host-plaintext fallback from `provision-enclave-compute.sh` (the
  enclave now requires the KMS ciphertext).
- **Rotate the WIFs** (they were historically exposed on the edge + Vercel):
  generate fresh `oracle_verifier` + `updater` keys, KMS-seal them, provision the
  new ciphertexts, and update the on-chain kernel/registry identities. Retain
  the old keys read-only for any in-flight fulfillments signed under the old
  identity (mirror the Phase C X25519 rotation pattern).
- **Validation:** see §8.

---

## 6. Security Considerations

### 6.1 Attestation binding for signed transactions

- `/sign/n3` includes the enclave's current attestation summary
  (`PCR0/1/2`, `key_source: 'kms_attested'`) in every response, so the caller
  (and any auditor) can verify the signature was produced by the measured EIF.
- The CMK key policy continues to gate `kms:Decrypt` on
  `kms:RecipientAttestation:ImageSha384 = <PCR0>`; an unmeasured CVM (or the
  host) cannot unwrap the WIF, so it cannot produce a valid signature.
- The pinned-identity check (`reportPinnedNeoN3Role`) ensures the materialized
  key matches the on-chain identity even if the ciphertext is swapped.

### 6.2 Replay prevention

- `/sign/n3` accepts an `idempotency_key` and a `replay_window`; the enclave
  keeps a bounded in-memory dedupe set (mirroring the relayer's existing
  idempotency cache) and rejects a second sign for the same key within the
  window.
- The Neo N3 transaction itself carries a `validUntilBlock`; the endpoint
  refuses to sign a tx whose `validUntilBlock` is already past.
- The workflow's `step.do` retries reuse the same `idempotency_key`, so a
  retry after a partial failure cannot produce a second on-chain tx.

### 6.3 Rate limiting on the signing endpoint

- The gateway (`runtime-gateway.nginx.conf`) applies a per-token request rate
  (suggested: 10 req/s sustained, 30 burst) to `/sign/n3`, separate from the
  compute routes.
- The enclave additionally enforces a per-role concurrency cap (suggested: 4)
  to bound NSM contention with `/oracle/fulfill`.
- Over-limit responses are `429` with a `Retry-After`; the workflow's
  exponential backoff already handles this.

### 6.4 Authn / authz

- `/sign/n3` is gated by the same `MORPHEUS_RUNTIME_TOKEN` /
  `NITRO_API_TOKEN` bearer token as the other execution routes; the Cloudflare
  workflow uses its existing `MORPHEUS_EXECUTION_TOKEN` secret.
- The endpoint signs **only** with pinned roles (`updater`, `oracle_verifier`);
  arbitrary key import is not supported.
- The gateway continues to refuse every route except the allow-listed
  execution routes + `/sign/n3` + `/health` + `/attestation`.

### 6.5 What this does NOT cover

- EVM (secp256k1) signing — that is RC1 / Phase D (`PHASE-D-EVM-IN-TEE.md`).
- The neodid salt + SM masters — still SM-derived; tracked under Phase C
  follow-ups.
- The relayer's own host-env WIF resolution (`resolveLocalVerifierAccount`
  fast-path, RC5) — separate cleanup.

---

## 7. Rollback Plan

Each phase is reversible without a key rotation:

| Phase | Rollback action                                                                                                        | Effect                                                                           |
| ----- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1     | `rm /var/lib/morpheus/n3-signer-*-kms.b64` + `systemctl restart morpheus-nitro-signer`                                 | Enclave falls back to host-injected plaintext WIF (still works)                  |
| 2     | Remove `/sign/n3` from the enclave route set + gateway allow-list; redeploy EIF (or just gate it off via flag)         | Endpoint disappears; no caller depends on it yet                                 |
| 3     | Flip the `callback-broadcast` feature flag back to `callAppBackend(...)`                                               | Workflow signs via Vercel host path (pre-RC3 behavior)                           |
| 4     | Flip the `automation-execute` feature flag back to `callAppBackend(...)`                                               | Same as above for automation                                                     |
| 5     | **No rollback** — once the WIF is rotated and removed from edge/Vercel envs, the host-signing path is permanently dead | Rotation is the point of no return; only do Phase 5 after Phases 1–4 have soaked |

**Failure-mode fallback during Phases 3–4:** if `/sign/n3` returns 5xx or times
out, the workflow falls back to the Vercel host-signing path **and emits an
alert** (BetterStack heartbeat
`MORPHEUS_BETTERSTACK_CONTROL_CALLBACK_FAILURE_URL` for callback-broadcast; the
equivalent automation heartbeat for automation-execute). The fallback is logged
with `signing_path: 'vercel_host_fallback'` so it is auditable. The fallback is
removed in Phase 5.

---

## 8. Verification

The migration is complete when **all** of the following hold:

1. **No WIF in edge env.**
   `wrangler secret list` for `morpheus-control-plane` shows no
   `MORPHEUS_*_NEO_N3_WIF_*` / `MORPHEUS_*RELAYER_NEO_N3_WIF_*` entries;
   `git grep -nE 'NEO_N3_WIF|RELAYER_NEO_N3_WIF' deploy/cloudflare/` returns
   only the deletion commit + this doc.
2. **No WIF in Vercel env.** `apps/web` project settings show no
   `MORPHEUS_UPDATER_NEO_N3_WIF_*` / `MORPHEUS_RELAYER_NEO_N3_WIF_*`;
   `git grep -nE 'createNeoN3Account|UPDATER_NEO_N3_WIF' apps/web/` returns
   nothing in the signing path.
3. **Enclave key source is KMS-attested.** `GET /health` on the CVM reports
   `oracle_verifier` and `updater` with `key_source: 'kms_attested'` for both
   networks; `/var/lib/morpheus/n3-signer-*-kms.b64` exist and the host
   instance role **cannot** decrypt them (negative test:
   `aws kms decrypt --ciphertext-blob …` from the host fails with
   `AccessDeniedException` / attestation mismatch).
4. **All signatures come from the attested key.** For a sample of recent
   `callback-broadcast` + `automation-execute` on-chain txids, the witness
   verifies against the enclave's pinned identity (from `/keys/derived`), and
   the workflow logs show `signing_path: 'enclave_kms_attested'` (not
   `vercel_host_fallback`).
5. **Negative routing test.** A request to
   `https://runtime.meshmini.app/{net}/sign/n3` without the bearer token returns
   401; with the token but a non-pinned role returns 4xx; a tx with a past
   `validUntilBlock` is refused.
6. **Replay test.** Re-submitting the same `idempotency_key` within the
   `replay_window` returns a dedupe response, not a second signature.
7. **Attestation pinning.** The deployed EIF's PCR0 matches the value pinned in
   the CMK key policy (`aws kms get-key-policy --key-id
alias/morpheus-enclave-master`) and the measurement manifest under
   `deploy/nitro/measurements/`.
8. **Rotation evidence (Phase 5).** The on-chain kernel/registry identities
   match the new pinned identities; the old WIF is shredded and a signed
   attestation of destruction is recorded in the change log.

---

## Appendix A — Files touched (summary)

| File                                                                                       | Change                                                                        |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `deploy/nitro/enclave-server.mjs`                                                          | add `materializeNeoN3RoleKeyFromKms`, `POST /sign/n3` route + handler         |
| `deploy/nitro/provision-enclave-compute.sh`                                                | provision KMS ciphertexts; (Phase 5) drop plaintext fallback                  |
| `deploy/nitro/runtime-gateway.nginx.conf`                                                  | allow-list `/sign/n3`; per-token rate limit                                   |
| `deploy/nitro/measurements/<release>.json`                                                 | new EIF measurement manifest                                                  |
| `deploy/cloudflare/morpheus-control-plane/lib/execution-plane.js`                          | add `callEnclaveSignN3`; (Phase 5) delete `resolveNeoN3*Signer`               |
| `deploy/cloudflare/morpheus-control-plane/lib/workflows-impl.js`                           | swap `callAppBackend(...)` for build → `/sign/n3` → broadcast                 |
| `apps/web/lib/neo-control-plane.ts`                                                        | factor tx builders into a shared package; (Phase 5) remove env-WIF resolution |
| `apps/web/app/api/internal/control-plane/{callback-broadcast,automation-execute}/route.ts` | (Phase 5) retire host-signing path                                            |
| AWS KMS key policy (`alias/morpheus-enclave-master`)                                       | update PCR0 to the new EIF (Phase 1)                                          |

## Appendix B — Open questions

- Should broadcast also move into the enclave (so the workflow only triggers),
  or stay in the workflow? Broadcast is non-confidential; keeping it in the
  workflow preserves the existing retry/DLQ semantics. Recommend: keep broadcast
  in the workflow for now.
- Should the relayer's primary path also adopt `materializeNeoN3RoleKeyFromKms`
  (closing RC5's `resolveLocalVerifierAccount` fast-path)? Recommend: yes, as a
  follow-up that reuses Phase 1's materializer.
