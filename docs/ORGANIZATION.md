# Repository Organization

This document records the organization of neo-os-services according to the approved standard (2026-09-25).

## Repository Ownership

This repository owns gateway-layer (L3) services:

- **C12 sign**: Signer policy, caller auth, network binding, per-key limits
- **C14 deliver**: DeliveryJob, journal-before-broadcast, callbacks, sponsored submission
- **C15 compute**: Oracle/HTTP/VRF/seal/compute execution in enclave, game-session service
- **C16 identity-service**: DID issuer/verifier/resolver (pinned from neo-os-did)
- **C17 ingress**: Public edge gateway, queues, workflows, rate limiter

## Layout

- `workers/`: Production Rust and Node workers (nitro-enclave-host, neo-os-relayer, etc.)
- `crates/`: Rust libraries
- `packages/`: Shared TypeScript packages
- `apps/`: Applications (web moved to neo-os-admin per v2)
- `contracts/`: Pinned contract artifacts only (sources in neo-os-contracts)
- `contracts-evm/`: EVM contracts (archive status per ARCHITECTURE.md)
- `deploy/`: Infrastructure, container, service configs
- `db/services/`: Database migrations, policies, tests (moved from supabase/)
- `scripts/`: Build, test, ops scripts
- `docs/`: Documentation, including reports/ for audits/plans
- `tests/`: Integration and cross-component tests
- `examples/`: Usage examples
- `vendor/`: Pinned dependencies with provenance
- `baselines/`: Evidence baselines for gates
- `config/`: Configuration files

## What Must Never Be Added

- **Contract sources**: Owned by neo-os-contracts (platform/app/Oracle) or neo-os-aa (AA) or neo-os-did (NeoDID)
- **Catalog writing**: Owned by neo-os-admin only
- **Workspace registries**: Owned by neo-os-workspace (neo-os-web keeps enforced copy until v2 adoption)
- **SDK sources**: Versioned DevPack packages only
- **Tracked build outputs**: Must be rebuildable (clean build proves regeneration)
- **Tool state directories**: .idea, .codex, .opencode, .omx, .workbuddy, .planning, .mimosa

## Planned Cross-Repo Moves

Per ARCHITECTURE.md v2:
- `contracts/` sources → neo-os-contracts (C05) - keep pinned artifacts only
- `apps/web` → neo-os-admin (C20)
- `config/networks` → neo-os-workspace (C08)

## Deleted Paths

Paths removed with proof of no production/build/deploy/runtime use:

### services/neoswap/ (64 files, deleted 2026-09-26)
- **Last commit**: b880823 (2026-09-26)
- **Reason**: Declared "delete" in ARCHITECTURE.md v2; generic services outside npm workspaces
- **Cross-repo check**: Only referenced in neo-os-web v2 architecture proposals (design docs)
- **Build/deploy check**: CI only built/tested neoswap (no deployment); no production systemd units
- **Runtime check**: No production configuration, no deploy scripts, no service units
- **Proof**: Searched all sibling repos' origin default branches - no consumers

### Tool state directories (deleted 2026-09-26)
- `.planning/` - audit/roadmap notes moved to docs/
- `.workbuddy/memory/` - session memory, not durable documentation

## 2026-09-27 Verification Addendum

Baseline HEAD for this verification: `09e1c8b1decf3c6509aaff1f72625cab9994e0f5`.
The preceding organization text is retained unchanged. This addendum supplies the
approved headings and records current paths separately from approved ownership.

## Purpose

`neo-os-services` owns the confidential services and gateway runtime boundary: Oracle and
DataFeed compatibility services, compute and relayer workers, ingress/control-plane
components, and the signer custody service. The tracked README identifies `workers/`,
`crates/`, `packages/`, `apps/web`, `deploy/`, `db/services/migrations/`, `contracts/`,
`docs/`, and `scripts/` as current repository surfaces.

## Authority Boundaries (OWNS/NEVER OWNS)

### OWNS

- Runtime services and workers for Oracle, DataFeed, VRF, compute, paymaster integration,
  relaying, ingress, and control-plane delivery.
- The signer service security boundary, including signer policy, caller registry, network
  binding, limits, and audit trail under `workers/neo-signer/` and its documented support
  paths.
- Service-owned network identity projections under `config/networks/`, service migrations
  under `db/services/migrations/`, operational code under `deploy/` and `scripts/`, and
  service documentation and evidence under `docs/`.
- Pinned NeoDID consumer data under `vendor/neo-os-did/` as governed by its pin and drift
  check; this is a consumer projection, not NeoDID source ownership.

### NEVER OWNS

- Platform, application, or Oracle contract source as the canonical contract owner; the
  approved standard assigns it to `neo-os-contracts`.
- AA contract source (`neo-os-aa`), NeoDID protocol source (`neo-os-did`), SDK source
  (`neo-os-devpack`), catalog writing (`neo-os-admin`), or workspace registries
  (`neo-os-workspace`).
- Private keys outside the documented signer custody boundary, or unreviewed production
  deployment/publication writes.

### Approved ownership versus present paths

The approved standard says `neo-os-services` keeps runtime services, durable migrations,
network identity, and signer policy. The tracked `apps/web`, `contracts/`, and
`contracts-evm/` paths are present at this HEAD and are described by the existing README and
organization text as host/compatibility or pinned/legacy surfaces. Their presence does not
transfer canonical contract or catalog ownership and does not prove a planned move complete.

## Directory Structure

The tracked top-level roots are:

```text
apps/             service web/control-plane application
baselines/        verification baselines
config/            network and runtime configuration projections
contracts/         present kernel/compatibility contract path
contracts-evm/     present EVM compatibility path
crates/            Rust service libraries
db/services/       service migrations, policies, and durability data
deploy/            deployment and enclave/edge configuration
docs/              architecture, deployment, operations, validation, and specs
examples/          service integration examples
packages/          shared TypeScript packages
scripts/           build, verification, operations, and registry helpers
tests/             integration and component tests
vendor/            pinned dependencies and provenance-controlled data
workers/           production Rust and Node workers
```

The complete tracked tree is defined by `git ls-tree -r HEAD`. The checkout has unrelated
untracked build and package files; they were not touched or classified as tracked source.

## File Organization Rules

- Keep production workers in `workers/`, Rust libraries in `crates/`, shared packages in
  `packages/`, and service migrations in `db/services/migrations/` using one domain layout.
- Keep network identity and public runtime projections tied to their generating source and
  digest; keep secret-bearing environment files uncommitted.
- Keep contract source out of new service features. Consume pinned artifacts or narrow
  interfaces and record provenance under the existing service checks.
- Keep signer code and custody policy behind the documented signer boundary; do not add
  WIF-bearing call sites to unrelated repositories.
- Do not move directories as part of documentation work.

## Cross-Repository Dependencies

- `neo-os-contracts` supplies platform contract source, manifests, and deployment evidence;
  services consume pinned artifacts or integration interfaces.
- `neo-os-aa` supplies AA contract interfaces/artifacts; service relay and paymaster paths
  are consumers of AA authorization, not owners of its source.
- `neo-os-devpack` supplies versioned app SDK packages and types.
- `neo-os-miniapps` consumes service catalogs and network/runtime projections for app
  features; catalog publication remains with `neo-os-admin`.
- `neo-os-workspace` is the approved future owner of cross-repository registries and gates;
  current enforced authority remains governed by the adoption state.
- Local remotes are named `origin` and `rustforneo`; policy designates `origin` as
  r3e-network canonical and `rustforneo` as the CI mirror. Exact URLs are omitted.

## Maintenance Guidelines

- Run repository verification, signer-boundary, migration, network-registry, and artifact
  provenance checks for affected paths; distinguish local checks from live read-back.
- Keep all service and deployment claims tied to exact source HEADs, generated manifests,
  immutable artifacts, and current runtime evidence.
- Treat `apps/web`, `contracts/`, and `contracts-evm/` as observed current paths until a
  reviewed migration proves ownership and dependent checks have moved.
- Preserve unrelated dirty worktrees and untracked files. Update only this document for
  organization documentation work.
