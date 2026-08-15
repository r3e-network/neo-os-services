# MiniApp OS Audit

This audit records the current state of the repository after the on-chain kernel refactor toward `miniapp-os + miniapps`.

## What Is Aligned

- The Neo N3 contract layer now exposes a kernel-oriented model instead of an oracle-only model.
- `MorpheusOracle` acts as the shared MiniApp OS kernel while keeping the legacy deployment name.
- The kernel owns miniapp registration, module registration, capability grants, request routing, inbox delivery, fee credits, and generic app state.
- `MorpheusDataFeed` is framed as a built-in shared numeric resource module.
- `OracleCallbackConsumer` is framed as an optional external adapter rather than a mandatory primitive.
- Contract tests and contract docs have been updated to describe the kernel model.
- The relayer now has an internal `module + operation` interpretation layer over legacy `requestType`, so runtime semantics can evolve without breaking the current on-chain compatibility path.

## What Is Still Oracle-Centric

- Many docs outside `contracts/` still describe the system as an oracle gateway first and a platform second.
- Several examples still teach `Request(...) + callback consumer` as the default integration shape.
- Frontend docs and launchpad text still surface the callback consumer as a first-class default.
- Scripts and environment variable naming still use `oracle` language even where the capability is now more general.
- Control-plane, relayer, and worker code paths still route mostly by oracle-specific request taxonomy.

## High-Priority Migration Areas

- `docs/ARCHITECTURE.md`
- `docs/ASYNC_PRIVACY_ORACLE_SPEC.md`
- `docs/EXAMPLES.md`
- `docs/USER_GUIDE.md`
- `apps/web/app/docs/**`
- `apps/web/components/launchpad/**`
- `scripts/setup-morpheus.mjs`
- `scripts/deploy-service-gateway.mjs`
- `scripts/verify-morpheus-n3.mjs`

## Architectural Direction

- Treat the control plane as the OS runtime, not as an oracle-only ingress.
- Route jobs by `miniapp + module + operation`, not by a flat oracle request type alone.
- Keep callback persistence inside the system as the canonical path.
- Use external callback contracts only as optional adapters.
- Prefer registration and capability grants over deploying per-miniapp plumbing contracts.
- Keep built-in modules composable so more miniapps can share the same contracts and services.

## Remaining Risks

- The repo still contains many user-facing references to the legacy oracle-first contract model.
- Off-chain workers have not yet been fully renamed or normalized around kernel vocabulary.
- Compatibility shims exist in the kernel, which is useful for migration, but they also prolong mixed terminology if not phased out deliberately.

## Status Update

As of the current tree, the **documentation positioning migration has largely landed**: the
oracle-first framing ("oracle gateway", "oracle-first", "oracle-centric") no longer appears in the
active docs under `docs/` or `apps/web/app/docs/` — only in this audit snapshot and in archived
reports. `docs/ARCHITECTURE.md`, `docs/ASYNC_PRIVACY_ORACLE_SPEC.md`, and the runtime docs already
describe the system as a `miniapp-os + miniapps` kernel with the Oracle CVM as a built-in module
lane.

What remains oracle-shaped is **intentional compatibility surface**, per the naming policy in
`README.md`: the on-chain `MorpheusOracle` / `MorpheusDataFeed` contract names, `MORPHEUS_*`
environment variables, and existing endpoints stay as compatibility interfaces for deployed
contracts and operators — they are not meant to be renamed. The residual "oracle" request
taxonomy in the relayer/worker is likewise a compatibility shim over the kernel model, kept
deliberately so runtime semantics can evolve without breaking the on-chain path.

Remaining low-risk follow-ups (not part of the compatibility surface):

- `scripts/*.mjs` and env variable names that still use "oracle" where the capability is now
  general (evaluated case-by-case, since some feed the `MORPHEUS_*` compatibility layer).
