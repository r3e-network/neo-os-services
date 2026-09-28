# Repository Organization

This document records the organization of neo-os-services according to the approved standard (2026-09-25).
The Layout section describes the tree as it is; moves that are planned but not done are listed
separately under Planned Cross-Repo Moves.

## Repository Ownership

This repository owns gateway-layer (L3) services:

- **C12 sign**: Signer policy, caller auth, network binding, per-key limits
- **C14 deliver**: DeliveryJob, journal-before-broadcast, callbacks, sponsored submission
- **C15 compute**: Oracle/HTTP/VRF/seal/compute execution in enclave, game-session service
- **C16 identity-service**: owned by neo-os-did; this repository runs its pinned consumer copies
- **C17 ingress**: Public edge gateway, queues, workflows, rate limiter

## Layout

- `workers/`: Production Rust and Node workers (nitro-enclave-host, neo-os-relayer, etc.)
- `crates/`: Rust libraries
- `packages/`: Shared JavaScript packages
- `apps/web`: Operator web application, built and deployed to Vercel from this repository
- `contracts/`: Neo N3 contract sources (MorpheusOracle, MorpheusDataFeed, OracleCallbackConsumer)
  and their tests, built by CI
- `contracts-evm/`: Neo X (EVM) contracts, built and tested by CI; declared for archive in
  ARCHITECTURE.md
- `deploy/`: Infrastructure, container, service configs
- `db/services/`: PostgreSQL migrations (`migrations/`) and `seed.sql`, moved from the former
  top-level Supabase directory in 7f430ab
- `scripts/`: Build, test, ops scripts
- `docs/`: Documentation (`docs/reports/` is gitignored local output, not part of the tree)
- `tests/`: SQL acceptance tests for the durable delivery queue, run on PostgreSQL by
  `scripts/test-relayer-delivery-v2.sh`
- `examples/`: Usage examples
- `vendor/`: Pinned dependencies with provenance
- `baselines/`: Evidence baselines for gates
- `config/`: Configuration files

## What Must Never Be Added

- **New contract sources**: Owned by neo-os-contracts (platform/app/Oracle) or neo-os-aa (AA) or
  neo-os-did (NeoDID); the existing Morpheus sources stay here until their planned move
- **Catalog writing**: Owned by neo-os-admin only
- **Workspace registries**: Owned by neo-os-workspace (neo-os-web keeps enforced copy until v2 adoption)
- **SDK sources**: Versioned DevPack packages only
- **Tracked build outputs**: Must be rebuildable (clean build proves regeneration)
- **Tool state directories**: .idea, .codex, .opencode, .omx, .workbuddy, .planning, .mimosa

## Planned Cross-Repo Moves

Per ARCHITECTURE.md v2:

- `contracts/` sources → neo-os-contracts (C05), keeping pinned artifacts only (not started)
- `apps/web` → neo-os-admin (C20) (not started)
- `config/networks` → neo-os-workspace (C08) (not started)

## Deleted Paths

Paths removed with proof of no production/build/deploy/runtime use:

### services/neoswap/ (64 files, deleted 2026-09-26)

- **Last commit**: b880823 (2026-09-26)
- **Reason**: Declared "delete" in ARCHITECTURE.md v2; generic services outside npm workspaces
- **Cross-repo check**: No runtime consumer in the sibling repositories' default branches
  (neo-os-minigames not inspected). Documentation still names it: neo-os-web's v2 architecture
  contract declares the deletion, and neo-os-miniapps
  `services/stealthex/CROSS_CHAIN_IMPLEMENTATION.md:71` lists a NeoSwap check command that no
  longer exists
- **Build/deploy check**: CI built and tested neoswap (no deployment); no production systemd
  units. The same CI job held the only apps/web audit and lockfile gates; they now run in
  lint-and-format against the root lock (`scripts/dependency-security.test.mjs`)
- **Runtime check**: No production configuration, no deploy scripts, no service units
- **Residue removed later**: the NeoSwap README-only `tests/integration/` and `tests/performance/`
  and `fuzz-testing/run-daily-fuzz.sh`

### Tool state directories (deleted 2026-09-26)

- `.planning/` - audit/roadmap notes, deleted rather than moved (none of the 32 files under
  `.planning/` and `.workbuddy/` is in the tree; they are recoverable from history at cc2e500)
- `.workbuddy/memory/` - session memory, not durable documentation

### Top-level Supabase directory (moved 2026-09-26)

- Migrations and `seed.sql` moved byte-identically to `db/services/` in 7f430ab.
- The acceptance script, the relayer schema test and the automation-claim test kept reading the
  old location until they were repointed; `scripts/db-migration-paths.test.mjs` now fails if any
  tracked file names the old path.
- neo-os-web's protocol registry and cross-repo gate still name the old DeliveryJob migration
  paths and need the matching update there.
