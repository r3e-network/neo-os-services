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

