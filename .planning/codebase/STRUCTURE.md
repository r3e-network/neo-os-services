# Structure

Date: 2026-07-04

## Top-Level Directory Layout

```text
neo-morpheus-oracle/
├── apps/                    # Next.js web application
├── config/                  # Network registry configs
├── contracts/               # Neo N3 C# contracts
├── contracts-evm/           # EVM Solidity contracts
├── deploy/                  # Deployment configurations
├── docs/                    # Documentation
├── examples/                # Example integrations and tests
├── monitoring/              # Monitoring and observability configs
├── packages/                # Shared internal packages
├── scripts/                 # Deployment, verification, and operator scripts
├── supabase/                # Database migrations
├── workers/                 # Background workers
├── package.json             # Root package with workspaces
├── neo-morpheus-oracle.sln  # C# solution file
├── nitro.request-hub.toml   # Oracle CVM launcher config
├── nitro.feed-hub.toml      # DataFeed CVM launcher config
├── .env.example             # Root environment template
├── .env.development.example # Development environment template
├── .env.production.example  # Production environment template
├── .eslintrc.json           # ESLint configuration
├── .prettierrc              # Prettier configuration
├── .gitignore               # Git ignore rules
└── README.md                # Project overview
```

## Workspace Organization

The root `package.json` declares npm workspaces:

```json
"workspaces": [
  "apps/*",
  "workers/*",
  "packages/*"
]
```

Each first-level directory under `apps/`, `workers/`, and `packages/` is a workspace with its own `package.json`. Use workspace names like `@neo-morpheus-oracle/web`, `@neo-morpheus-oracle/nitro-worker`, and `@neo-morpheus-oracle/morpheus-relayer` when importing between workspaces.

## Subsystems

### `apps/web` — Next.js Dashboard and Control-Plane API

- `app/` — Next.js App Router routes and pages.
  - `app/api/` — API routes (Route Handlers). One directory per route, with `route.ts` inside.
  - `app/docs/` — Documentation pages, mapped from `docs/` markdown files.
  - `app/explorer/` — On-chain explorer page.
  - `app/launchpad/` — Launchpad pages (`page.tsx`, `neodid-live/`, `neodid-resolver/`).
  - `app/status/` — Status page.
  - `app/verifier/` — Attestation verifier UI.
  - `app/admin/` — Admin page.
- `components/` — React components.
  - `components/dashboard/` — Dashboard widgets (`OracleRequestForm.tsx`, `ComputeEditor.tsx`, `OverviewStats.tsx`, etc.).
  - `components/starter/` — Starter UI panels (`RequestTypePanel.tsx`, `SealedBlobPanel.tsx`, etc.).
  - `components/launchpad/` — Launchpad components.
  - `components/ui/` — Reusable UI primitives (`Card.tsx`, `Toast.tsx`, `Skeleton.tsx`, etc.).
  - `components/illustrations/` — Illustration components.
- `lib/` — Shared server/client libraries.
  - `lib/workflow-runtime.ts` — Workflow catalog utilities and public catalog helpers.
  - `lib/public-config.ts` — Public configuration.
  - `lib/rate-limit.ts` — Rate limiting.
  - `lib/service-health.ts` — Service health.
  - `lib/n3index-feed.ts` — Neo N3 index feed helpers.
  - `lib/nep21.ts` — NEP-21 helpers.
  - `lib/browser-encryption.ts` — Browser-side encryption helpers.
  - `lib/neodid-did-common.ts` — NeoDID DID helpers.
  - `lib/relayer-auth.ts` — Relayer auth helpers.
  - `lib/app-url.ts` — App URL resolution.
  - `lib/docs-navigation.ts` — Docs navigation.
- `public/` — Static assets and generated catalogs.
  - `public/morpheus-runtime-catalog.json` — Generated public runtime catalog.
  - `public/morpheus-network-registry.json` — Generated public network registry.
  - `public/brand/` — Brand assets.
- `__tests__/` — Vitest tests.
- `next.config.mjs` — Next.js configuration.
- `vitest.config.ts` — Vitest configuration.
- `sentry.*.config.ts` — Sentry configuration.
- `instrumentation.ts` and `instrumentation-client.ts` — Next.js instrumentation.

### `workers/nitro-worker` — Confidential Execution Runtime

- `src/worker.js` — Main CVM entry point. Exports a `fetch` handler.
- `src/server.js` — Local HTTP server adapter that wraps `worker.js` for development and non-Cloudflare deployments.
- `src/platform/` — Platform primitives.
  - `core.js` — request handling, env, JSON helpers, body parsing.
  - `auth.js` — TEE-side auth.
  - `nitro-signer.js` — Nitro attestation and derived signing.
  - `request-guards.js` — request guards and guard result persistence.
  - `overload-guard.js` — overload protection.
  - `circuit-breaker.js` — circuit breaker.
  - `risk-observer.js` — risk observation.
  - `policy-engine.js` — policy engine.
  - `script-runner.js` — JavaScript execution.
  - `script-source.js` — script source loading and validation.
  - `script-policy.js` — script policy enforcement.
  - `wasm-runner.js` — WASM execution.
  - `allowlist.js` — platform allowlist.
  - `execution-plan.js` — execution plan normalization.
  - `result-envelope.js` — result envelope construction.
  - `ssrf.js` — SSRF protection.
  - `upstash.js` — Upstash integration.
- `src/oracle/` — Oracle module lane.
  - `index.js` — oracle module entry.
  - `feeds.js` — feed execution.
  - `feeds/` — feed state, sync policy, decimal handling, Neo stack decoding.
  - `fetch.js` — private HTTP fetching.
  - `fetch-dispatcher.js` — fetch dispatch.
  - `crypto.js` — cryptographic helpers.
  - `vrf.js` — VRF logic.
  - `aggregation.js` — aggregation logic.
  - `providers.js` — provider handling.
  - `message-reveal.js` — message reveal.
- `src/compute/` — Compute module lane.
  - `index.js` — compute entry and built-in function dispatch.
- `src/neodid/` — NeoDID module lane.
  - `index.js` — NeoDID request handling.
- `src/chain/` — Chain adapters and signing.
  - `neo-n3.js` — Neo N3 adapter.
  - `signing.js` — signing utilities.
  - `index.js` — chain exports.
- `src/paymaster/` — Paymaster logic.
- `src/game/` — Game engine examples and wrappers.
- `src/capabilities.js` — capability resolution.
- `worker.test.mjs` — top-level worker tests.
- `package.json` — workspace manifest with `type: "module"`.

### `workers/morpheus-relayer` — On-Chain Async Bridge

- `src/cli.js` — CLI entry.
- `src/relayer.js` — Main loop orchestration and run snapshots.
- `src/neo-n3.js` — Neo N3 scanning, request reading, and fulfillment.
- `src/neox.js` — Neo X scanning and fulfillment.
- `src/feed-sync.js` — Feed synchronization and payload construction.
- `src/automation.js` — Automation job processing.
- `src/automation-supervisor.js` — Automation supervisor logic.
- `src/persistence.js` — Supabase persistence and backoff.
- `src/queue.js` — Durable queue management.
- `src/state.js` — Relayer state file and metrics.
- `src/router.js` — Request routing between chains and modules.
- `src/fulfillment.js` — On-chain fulfillment.
- `src/chain-cursor.js` — Chain cursor management.
- `src/request-processor.js` — Per-chain request processing.
- `src/lib/neo-signers.js` — Neo signer helpers.
- `src/lib/retry.js` — Retry logic.
- `src/lib/secret-redaction.js` — Secret redaction.
- `src/lib/strings.js` — String helpers.
- `src/prometheus.js` — Prometheus metrics rendering.
- `src/metrics-server.js` — Metrics HTTP server.
- `src/heartbeat.js` — Heartbeat sender.
- `src/attestation.js` — Attestation handling.
- `src/healthcheck.js` — Health check server.
- `src/betterstack-log-sink.js` — Better Stack log sink.
- `src/config.js` — Runtime configuration builder.
- `src/config-schema.js` — Configuration schema.
- `src/config-introspect.js` — Config introspection helpers.
- `relayer.test.mjs` — top-level relayer tests.
- `package.json` — workspace manifest with `type: "module"`.

### `packages/shared` — Shared Internal Library

- `src/index.js` / `src/index.ts` — Main exports.
- `src/utils.js` — Utility functions (`trimString`, `parseTimestampMs`, JSON helpers).
- `src/cbor.js` — CBOR encoding/decoding.
- `src/cose-verify.js` — COSE verification.
- `src/confidential-envelope.js` — Confidential envelope handling.
- `src/public-runtime.js` — Public runtime helpers and types.
- `src/node-runtime.js` — Node runtime helpers.
- `src/automation-supervisor.js` — Automation supervisor logic.
- `src/callback-methods.js` — Callback method utilities.
- `src/neo-encoding.js` — Neo encoding helpers.
- `src/neo-signers-core.js` — Neo signer core.
- `src/rate-limit.js` — Rate limiting utilities.
- `src/workflow-catalog.js` — Workflow catalog definitions.
- `src/stable-stringify-vectors.mjs` — Stable vector stringification.
- `package.json` — defines conditional exports for `utils`, `cbor`, `cose-verify`, `automation-supervisor`, `callback-methods`, `neo-encoding`, `neo-signers-core`, `rate-limit`, `public-runtime`, and `node-runtime`.

### `contracts/` — Neo N3 C# Contracts

- `MorpheusOracle/` — MiniApp OS kernel.
  - `MorpheusOracle.cs` — kernel entry.
  - `MorpheusOracle.Requests.cs` — request handling.
  - `MorpheusOracle.Fulfillment.cs` — fulfillment logic.
  - `MorpheusOracle.Storage.cs` — storage layout.
- `MorpheusDataFeed/` — Shared data feed module.
  - `MorpheusDataFeed.cs` — data feed implementation.
- `NeoDIDRegistry/` — NeoDID registry.
  - `NeoDIDRegistry.cs` — NeoDID registry implementation.
- `OracleCallbackConsumer/` — Optional callback adapter.
  - `OracleCallbackConsumer.cs` — callback consumer implementation.
- `__tests__/` — C# contract tests.
- `build/` — Generated contract artifacts (`.artifacts.cs` files).
- `neo-morpheus-oracle.sln` — C# solution file at repository root.

### `contracts-evm/` — EVM Solidity Contracts

- `MorpheusOracleEVM.sol` — EVM oracle implementation.
- `IMorpheusOracleEVM.sol` — Oracle interface.
- `MorpheusPriceFeed.sol` — Price feed example.
- `MiniAppDiceGameEVM.sol` — Dice game miniapp example.
- `MiniAppMessageEVM.sol` — Message miniapp example.
- `Owned.sol` — Ownership base contract.
- `Updatable.sol` — Updatable base contract.
- `test/` — Solidity tests (`MorpheusOracleEVM.t.sol`, `TestBase.sol`).
- `build/` and `cache/` — Hardhat/Foundry build artifacts (ignored by Git).

### `deploy/` — Deployment and Infrastructure

- `cloudflare/morpheus-control-plane/` — Control plane Cloudflare Worker.
  - `worker.mjs` — worker entry.
  - `lib/` — internal libraries.
  - `workflow-runtime.mjs` — workflow runtime entry.
  - `wrangler.meshmini.toml` — production wrangler config.
  - `wrangler.example.toml` — example wrangler config.
- `cloudflare/morpheus-edge-gateway/` — Edge gateway Cloudflare Worker.
  - `worker.mjs` — worker entry.
  - `worker.test.mjs` — tests.
  - `wrangler.meshmini.toml` — production wrangler config.
  - `wrangler.example.toml` — example wrangler config.
- `nitro/` — Nitro / AWS enclave deployment.
  - `docker-compose.yml` and `docker-compose.*.yml` — Docker Compose files for request hub, feed hub, split relayer, and UI variants.
  - `enclave-server.mjs` — enclave server.
  - `nitro-signer-server.mjs` — Nitro signer server.
  - `host-egress-proxy.mjs` — host egress proxy.
  - `measurements/` — Enclave measurement JSON artifacts.
  - `*.allowlist.yaml` — egress allowlists.
- `feed-pusher/` — Feed pusher scripts and tests.
  - `feed-pusher.mjs` — feed pusher.
  - `feed-monitor.mjs` — feed monitor.
  - `feed-topup.mjs` — feed top-up.
  - `db-prune.mjs` — database prune.
- `evm/` — EVM deployment and validation scripts.
  - `deploy.mjs`, `compile.mjs`, `oracle-admin.mjs`.
  - `neox-fulfiller.mjs` — Neo X fulfiller.
  - `callback-monitor.mjs` — callback monitor.
  - `validate-*.mjs` — validation scripts (dice, HTTP, VRF).
- `systemd/` — Systemd service unit files.

### `supabase/` — Database Migrations

- `migrations/0001_morpheus_schema.sql` — Core schema (projects, secrets, requests, compute jobs, feed snapshots).
- `migrations/0002_morpheus_policies_and_seeds.sql` — Policies and seed data.
- `migrations/0003_provider_configs.sql` — Provider configurations.
- `migrations/0004_relayer_ops.sql` — Relayer operations tables.
- `migrations/0005_operation_logs.sql` — Operation logs.
- `migrations/0006_automation.sql` — Automation tables.
- `migrations/0007_system_backups.sql` — System backups.
- `migrations/0008_network_isolation.sql` — Network isolation.
- `migrations/0009_relayer_durable_queue_indexes.sql` — Relayer durable queue indexes.
- `migrations/0010_control_plane_jobs.sql` — Control-plane job tables.
- `migrations/0011_workflow_runtime.sql` — Workflow runtime state.
- `migrations/0012_policy_and_risk_controls.sql` — Policy and risk controls.
- `migrations/0013_automation_processing_claims.sql` — Automation processing claims.
- `migrations/0014_tighten_request_job_rls.sql` — RLS hardening for request jobs.
- `migrations/0015_harden_operational_table_rls.sql` — RLS hardening for operational tables.

### `scripts/` — Operational Scripts

- Deployment and upgrades: `deploy-oracle.mjs`, `deploy-callback-consumer.mjs`, `upgrade-morpheus-datafeed.mjs`.
- Verification and smoke tests: `verify-morpheus-n3.mjs`, `verify-repo.sh`, `smoke-oracle-n3.mjs`, `smoke-control-plane.mjs`, `smoke-all.mjs`.
- Feed operations: `audit-feed-freshness.mjs`, `audit-feed-registry-drift.mjs`, `backfill-feed-pairs.mjs`, `check-feed-freshness.mjs`.
- Registry/catalog exports: `export-public-network-registry.mjs`, `export-public-runtime-catalog.mjs`, `write-address-registry.mjs`.
- Signer and key management: `publish-oracle-public-key.mjs`, `publish-oracle-verifier-key.mjs`, `generate-nitro-signer-identity.mjs`, `check-neo-signers.mjs`, `audit-neo-n3-signer-files.mjs`.
- SaaS sync: `checkly-*`, `betterstack-*` scripts.
- Environment checks: `check-root-env.mjs`, `check-control-plane-env.mjs`, `check-nitro-env.mjs`, `check-web-cron-env.mjs`.
- Nitro rendering: `render-nitro-compose-env.mjs`, `render-nitro-env.mjs`, `render-nitro-hub-env.mjs`.
- Examples orchestration: `examples/scripts/` and root-level `examples:test:*` scripts.
- Utility libraries: `lib-*.mjs` helper modules (keep shared logic here, not duplicated in scripts).

### `examples/` — Example Integrations

- `browser-encryption/` — Browser encryption example.
- `node-encryption/` — Node.js encryption example.
- `contracts/n3/` — Neo N3 example contracts.
- `deployments/` — Example deployment configs.
- `payloads/` — Example request payloads.
- `scripts/` — Example test and deploy scripts.
- `wasm/` — WASM example.
- `build/` — Build artifacts (ignored by Git).

### `docs/` — Documentation

- `ARCHITECTURE.md`, `DEPLOYMENT.md`, `OPERATIONS.md`, `VALIDATION.md`, `ENVIRONMENT.md`.
- `ASYNC_PRIVACY_ORACLE_SPEC.md`, `ATTESTATION_SPEC.md`, `BUILTIN_COMPUTE.md`.
- `MINIAPP_OS_AUDIT.md`, `SECURITY_AUDIT.md`, `FRONTEND_READINESS_AUDIT.md`.
- `USER_GUIDE.md`, `RELAYER.md`, `PROVIDERS.md`, `PAYMASTER.md`.
- `NEODID_DID_METHOD.md`, `HPKE_X25519_MIGRATION.md`, `SAAS_STACK_INTEGRATION.md`.
- `plans/` — Design and implementation plans.
- `reports/` — Generated reports.
- `runbooks/` — Operational runbooks.

### `monitoring/` — Observability

- `checkly/` — Checkly API and browser check configs (`checks.example.json`, `README.md`).
- `grafana/` — Grafana Alloy configs (`alloy.relayer.example.alloy`, `README.md`).

### `config/` — Network Registry

- `config/networks/mainnet.json` — Canonical mainnet registry (RPC URLs, contract addresses, CVM IDs, AA config).
- `config/networks/testnet.json` — Canonical testnet registry.

## Where to Put New Code

- New UI pages or API routes: `apps/web/app/...`.
- New React components: `apps/web/components/<domain>/`.
- New shared web utilities: `apps/web/lib/<name>.ts`.
- New shared logic used by multiple workspaces: `packages/shared/src/<name>.js` and add a conditional export in `packages/shared/package.json` if it should be importable by path.
- New CVM execution module: `workers/nitro-worker/src/<module>/` with an `index.js` entry.
- New platform primitive: `workers/nitro-worker/src/platform/<name>.js`.
- New relayer logic: `workers/morpheus-relayer/src/<name>.js`.
- New relayer internal helper: `workers/morpheus-relayer/src/lib/<name>.js`.
- New Neo N3 contract: `contracts/<ContractName>/<ContractName>.cs` and add it to the C# solution.
- New EVM contract: `contracts-evm/<ContractName>.sol` and add tests in `contracts-evm/test/`.
- New control-plane worker library: `deploy/cloudflare/morpheus-control-plane/lib/<name>.js`.
- New database schema change: `supabase/migrations/XXXX_descriptive_name.sql` with sequential numbering.
- New operational script: `scripts/<verb>-<subject>.mjs` and add a root `package.json` script entry.
- New example integration: `examples/<topic>/`.
- New documentation: `docs/<TOPIC>.md`.
- New generated public artifact: `apps/web/public/<name>.json` with a generation script in `scripts/`.

## File Naming Conventions

- TypeScript/React files: `PascalCase.tsx` for page or component files, `camelCase.ts` for utilities and hooks.
- JavaScript modules: `kebab-case.js` or `camelCase.js`; prefer `kebab-case` for platform/service files.
- Test files: `<name>.test.ts` (Next.js/Vitest) or `<name>.test.mjs` (Node native test runner).
- Shared-worker tests: `<name>.shared-worker.test.mjs`.
- Migration files: `XXXX_description.sql` (zero-padded four-digit number).
- C# contracts: `PascalCase.cs`.
- Solidity contracts: `PascalCase.sol`.
- Config files: `kebab-case.json`, `kebab-case.toml`, or `kebab-case.yml`.
- Script files: `<verb>-<subject>.mjs`.
- Generated artifacts: `morpheus-<artifact>.json` or `<contract>.artifacts.cs`.

## Dependency Direction

The intended dependency graph is:

```text
apps/web
  ├── packages/shared
  └── (external) @cityofzion/neon-js, @supabase/supabase-js, next, react

workers/morpheus-relayer
  ├── packages/shared
  ├── workers/nitro-worker (for shared code imports)
  └── (external) @cityofzion/neon-js, ethers

workers/nitro-worker
  ├── packages/shared
  └── (external) @cityofzion/neon-js, ethers, jose, undici, @aws-sdk/client-secrets-manager

packages/shared
  └── (external) minimal; mostly self-contained
```

Avoid importing from `apps/web` into `workers/*` or `packages/shared`. The shared package is the only code that should be imported downward.
