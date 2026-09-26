# Security Audit Notes

This document tracks the current security hardening baseline for NeoOS Services and the checks that must pass before release.

## September 2026 Trust-Boundary Re-audit

The current tree was re-audited rather than treating earlier issue notes as current
fact. The findings below were live at the start of the remediation wave and are now
closed in the paired implementation/tests:

- measured production code no longer compiles an ordinary Secrets Manager
  `GetSecretValue` client for confidential masters; Recipient-attested KMS release
  is the only unwrap path;
- `/provision` is one-shot, allowlisted, and refuses plaintext key/token overlays;
  temporary AWS credentials rotate only through `/provision/credentials`;
- X25519 and NeoDID KMS ciphertexts materialize in-memory as purpose/network
  envelopes during provision;
- signed compute/oracle/NeoDID lanes return 503 unless custody identity matches;
  HTTP 200 never carries a null signature or public key;
- raw signing uses dedicated raw-only keys and a distinct `raw_sign` capability;
- production `privacy.add_noise` draws from `OsRng` (deterministic xorshift remains
  a test seam only);
- attested boundary JSON includes numeric `network_magic`;
- production Cloudflare confidential execution requires exactly one origin;
- runtime credential domain separation is enforced by deploy checkers, the shared
  `credential-separation` helper, production `apps/web/lib/config` startup, and the
  Cloudflare control-plane auth path (`auth_credential_collision`);
- local/CI/EIF toolchain is Rust 1.98.0 and publish triggers watch `packages/shared`;
- dBFT reservations checkpoint PrepareRequest/PrepareResponse together, ignore view
  for Commit, key immutable public key + network magic, and reserve before signing.

The following earlier concerns were stale in the current tree and must not be
reimplemented:

- fee ceilings already cover both system and network fees;
- rolling value and signature decisions are serialized across service clones, with
  audit/value/idempotency writes committed in one SQLite transaction;
- request-id completion is durable and exact-retry safe;
- transaction parsing already rejects negative/overflowing fees, trailing bytes,
  unknown attributes/opcodes, dynamic witness rules, and unaccounted script behavior.

### Required resolved posture

1. Measured production code accepts confidential material only as a KMS
   CiphertextBlob and unwraps it with a fresh Nitro Recipient attestation inside the
   enclave. The parent role has no `secretsmanager:GetSecretValue`,
   `kms:Encrypt`, `kms:GenerateDataKey*`, or plaintext-secret permission.
2. `/provision` is one-shot, uses an explicit allowlist, and rejects unknown names.
   `NODE_ENV`, network, endpoints, custody routing, raw key material, feature/policy
   toggles, and trust anchors are image-owned. A separately authenticated
   `/provision/credentials` route may rotate only temporary AWS access credentials.
3. Production X25519 and NeoDID KMS plaintexts are purpose/network/version envelopes.
   The enclave validates and materializes them only in memory and marks their source
   internally as Nitro Recipient KMS. Remote confidential references remain explicit
   503 until their authenticated claim transport is implemented.
4. All signed response lanes fail 503 unless custody key identity, enabled state,
   network, and response identity match. HTTP 200 never contains a null signature or
   public key.
5. Raw-only keys and `raw_sign` callers are distinct from semantic transaction and
   consensus authorities.
6. Security-sensitive random draws use `OsRng`; deterministic closures remain test
   seams only.
7. `network_magic` is present in key wire types and the attested boundary digest.
8. Production images/units set `NODE_ENV=production`; confidential Cloudflare
   execution has one origin and no cross-origin retry; runtime/workflow/operator/
   relayer/signing/relay/custody credentials are pairwise distinct via
   `@r3e-network/neo-os-services-shared/credential-separation`, deploy checkers,
   production web startup, and control-plane auth.
9. Rust 1.98.0 is the single local, CI, and EIF toolchain, and publish triggers cover
   every Docker build input, including `packages/shared`.
10. dBFT v3.10.1 bodies are fully consumed and checkpointed by immutable public key,
    network magic, height, and safe phase semantics before signing. The claimed
    validator index must match an exact retry but cannot create a parallel slot.

## Current Automated Coverage

- Root dependency audit is guarded by `scripts/check-root-audit-allowlist.mjs` so known CityOfZion baseline findings stay explicit instead of silently expanding. The checker runs the active npm CLI through the current Node executable when `npm_execpath` is available (including Windows), uses a shell-backed npm fallback only for direct Windows invocation, and reports process-launch failures instead of misclassifying them as an empty audit.
- Repository verification runs script tests, control-plane tests, worker checks/tests, relayer checks/tests, web consistency checks, web unit tests, and web production build.
- Web security headers are defined in `apps/web/next.config.mjs` and covered by `apps/web/__tests__/security-headers.test.ts`.
- Documentation navigation is covered by `apps/web/__tests__/docs-navigation.test.ts`, including static docs routes and extended Markdown-backed `/docs/r/*` pages.
- Contract artifact generation is validated by `scripts/contract-build-regressions.test.mjs` when `dotnet` and the pinned `nccs` compiler are available.

## Rust Advisory Disposition

`cargo audit` reports RUSTSEC-2023-0071 for RustCrypto `rsa` 0.9.10; no
patched release exists. Its disposition is open owner decision O22, recorded
with the reachability analysis in
`docs/security/RUST-DEPENDENCY-ADVISORIES-20260926.md`, which supersedes the
disposition this section used to give.

That earlier disposition treated a fresh, single-use RSA-2048 KMS recipient key
as the only RSA private-key operation and stated that the other `rsa` call sites
perform public-key verification only. That was wrong. neo-signer's per-process
RSA-3072 custody session key (`crates/nitro-attest/src/session_key.rs`) also
decrypts coordinator session tokens (blinded RSA-OAEP) and signs every
coordinator authority request with unblinded RSA-PSS, whose exponentiation
input the coordinator can recompute from each signature. That is a private key
reused across a remotely repeatable signing operation, the condition under which
this section said its exception had to be removed. The exception is therefore
withdrawn: there is no `cargo audit --ignore RUSTSEC-2023-0071` waiver. The
release check is plain `cargo audit`, and its RUSTSEC-2023-0071 finding stays
open until O22 is decided. `paste` is an unmaintained build-time
macro inherited from Boa and retires with that compatibility engine;
`serde_cbor` is the unmaintained target-specific dependency of AWS's Nitro NSM
API. Neither warning currently identifies a vulnerability, but both remain
migration debt rather than permanent exemptions.

## Manual Release Checklist

Before a production release, verify:

1. `npm run verify:repo` passes in a clean checkout.
2. The contract CI job installs the pinned Neo C# compiler and runs `contracts/build.sh` successfully.
3. No secrets, private keys, service-role keys, tokens, or connection strings are committed or printed in logs.
4. Production environment variables are scoped by network and deployment target.
5. Callback, relayer, paymaster, and txproxy allowlists are reviewed against the intended deployment contracts.
6. Any live smoke tests use dedicated testnet funds/accounts and do not reuse production signer material.
7. `cargo audit`, run without `--ignore`, reports no vulnerability other than
   RUSTSEC-2023-0071, and owner decision O22 on RUSTSEC-2023-0071
   (`docs/security/RUST-DEPENDENCY-ADVISORIES-20260926.md`) has been taken and
   recorded. Until it has, this item is not met.
8. `npm run format:rust:check`, `cargo clippy --workspace --all-targets --locked -- -D warnings`,
   and `cargo test --workspace --all-targets --locked` pass under Rust 1.98.0.
9. `npm run check:rust-migration`, documentation coverage, worker/relayer/ops/script
   suites, custody-plane E2E, the NeoNexus real-process contract, and gitleaks pass.
10. External-only blockers in `docs/EXTERNAL_RELEASE_BLOCKERS.md` are cleared or
    explicitly accepted by operators (key rotation, on-chain upgrades, host installs).
11. Production preflight confirms pairwise-distinct runtime/workflow/operator/
    relayer/signing/relay credentials and includes both signing and relay admin keys.
12. The release's PCR measurements are rebuilt, committed, and pinned by the KMS key
    policy before ciphertext is provisioned.

## Public API Route Policy

The following `apps/web` routes are intentionally public and are hardened against
enumeration and DoS abuse. They are rate-limited by `apps/web/lib/rate-limit.ts`
(Upstash-backed when configured, in-memory otherwise) and enforce Zod input
validation via `apps/web/lib/validators.ts`.

| Route                 | Authentication               | Rate limit | Validation                  |
| --------------------- | ---------------------------- | ---------- | --------------------------- |
| `/api/workflows`      | Runtime/admin token required | 60 req/min | No unexpected query params  |
| `/api/policies`       | Runtime/admin token required | 60 req/min | No unexpected query params  |
| `/api/networks`       | Public (no token)            | 60 req/min | No unexpected query params  |
| `/api/neodid/resolve` | Runtime/admin token required | 30 req/min | `did` and optional `format` |

Authentication uses the shared runtime-token check in
`apps/web/lib/control-plane-auth.ts` (`MORPHEUS_RUNTIME_TOKEN`,
`NITRO_API_TOKEN`, or `NITRO_SHARED_SECRET` presented as a Bearer token or
`x-morpheus-runtime-token` header). Unauthenticated requests to protected routes
receive `401 { error: 'unauthorized' }`; malformed inputs receive
`400 { error: 'invalid query parameters' }`; rate-limited requests receive
`429 { error: 'Too many requests', retryAfter }`. Responses include
`X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` headers.

## Known Environment Caveat

Local developer machines that do not have `dotnet` and `~/.dotnet/tools/nccs` installed will skip the contract compilation regression test. CI must still enforce contract compilation using the pinned compiler before release.

## Compatibility Child Process Hardening

The measured Rust EIF has no Node child or fallback engine. The separately published
Node compatibility worker still spawns untrusted scripts and WASM modules in child
processes. In that compatibility deployment the following settings must be enforced:

- The Node.js permission model is ON by default for script/WASM child processes. It can only be disabled by the explicit dev override `MORPHEUS_ALLOW_UNSANDBOXED_CHILDREN=1`, and that override is IGNORED when `NODE_ENV=production` (fail closed). The retired `SCRIPT_CHILD_ENABLE_PERMISSION_MODEL` toggle no longer has any effect.
- `SCRIPT_CHILD_ALLOW_NET` must contain specific hostnames or IP addresses. Wildcards (`*`), `0.0.0.0/0`, `::/0`, and CIDR blocks are rejected at startup.
- `SCRIPT_CHILD_ALLOW_FS_READ` and `SCRIPT_CHILD_ALLOW_FS_WRITE` should be limited to the paths required by the workload.
- The Node.js permission model is applied automatically via `buildPermissionExecArgv` in `workers/nitro-worker/src/platform/script-runner.js` and `wasm-runner.js`.

## Cron Diagnostic Policy

The `/api/cron/feed` endpoint returns a generic `401 { error: 'Unauthorized' }` response to unauthenticated callers. Diagnostic details (header presence, request metadata, and configuration checks) are logged server-side only and never included in the response body.
