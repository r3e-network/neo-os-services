# Architecture

Date: 2026-07-04

## Project Overview

`neo-morpheus-oracle` is a Neo N3-first confidential oracle stack. The production design keeps ingress, orchestration, and durability outside the TEE, and reserves confidential VMs for execution only. The repository is a multi-subsystem monorepo with npm workspaces (`apps/*`, `workers/*`, `packages/*`).

## Production Topology

```text
[ dApp / operator / automation client / registered miniapp ]
        |
        | encrypt optional secrets locally
        v
[ Neo N3 MiniApp OS kernel + built-in modules ] --+
        |                                         |
        | async kernel request / shared reads     | inbox delivery / optional adapter callback
        v                                         |
[ relayer durable intake ]                        |
        |                                         |
        | persist + retry + recover               |
        v                                         |
[ Cloudflare control plane ]                      |
  - auth / validation                             |
  - rate limiting                                 |
  - job persistence                               |
  - queue / workflow dispatch                     |
        |                                         |
        +--------------------------+--------------+
                                   |
                                   v
                       [ confidential execution plane ]
                       - Oracle CVM: built-in fetch / compute / NeoDID modules
                       - DataFeed CVM: continuous shared resource publication
                                   |
                                   v
                           [ signed / attested result ]
                                   |
                                   v
                        [ relayer broadcast + kernel inbox write ]
```

## Four Architectural Layers

### 1. Serverless Ingress and Control

Cloudflare Workers provide the public edge and control plane:

- `deploy/cloudflare/morpheus-edge-gateway/worker.mjs` — public edge entry, safe-GET caching, optional abuse controls.
- `deploy/cloudflare/morpheus-control-plane/worker.mjs` — `POST /mainnet/*` and `POST /testnet/*` ingress, auth, validation, rate limiting, recovery, queue dispatch, and workflow orchestration.
- `deploy/cloudflare/morpheus-control-plane/lib/auth.js` — request authentication and rate-limit application.
- `deploy/cloudflare/morpheus-control-plane/lib/jobs.js` — Supabase job persistence.
- `deploy/cloudflare/morpheus-control-plane/lib/queue-consumer.js` — queue consumers for `oracle_request` and `feed_tick`.
- `deploy/cloudflare/morpheus-control-plane/lib/workflows.js` and `lib/workflows-impl.js` — workflow dispatch and implementation.
- `deploy/cloudflare/morpheus-control-plane/lib/execution-plane.js` — calls the Nitro Oracle CVM.
- `deploy/cloudflare/morpheus-control-plane/lib/recovery.js` — job recovery and dead-letter logic.

This layer is intentionally stateless except for the job records it writes to Supabase.

### 2. Durable Orchestration

Managed Cloudflare primitives orchestrate work outside the TEE:

- Cloudflare Queue: `oracle_request` — confidential execution jobs.
- Cloudflare Queue: `feed_tick` — continuous price feed updates.
- Cloudflare Workflow: `callback_broadcast` — on-chain callback fulfillment.
- Cloudflare Workflow: `automation_execute` — automation execution.

Queue names retain legacy oracle shapes for compatibility with existing runtime code.

### 3. Durable State

Supabase is the durable source of truth. Schema migrations live in `supabase/migrations/`:

- `0001_morpheus_schema.sql` — core `morpheus_projects`, `morpheus_encrypted_secrets`, `morpheus_requests`, `morpheus_compute_jobs`, `morpheus_feed_snapshots`.
- `0010_control_plane_jobs.sql` — control-plane job tables.
- `0011_workflow_runtime.sql` — workflow runtime state.
- `0012_policy_and_risk_controls.sql` — policy and risk controls.
- `0013_automation_processing_claims.sql` — automation processing claims.
- `0014_tighten_request_job_rls.sql` and `0015_harden_operational_table_rls.sql` — row-level security hardening.

### 4. Confidential Execution

The confidential boundary is narrow. Only these operations enter the TEE:

- decrypting sealed payloads
- private HTTP fetches
- private compute and JS/WASM execution
- NeoDID private ticket flows
- confidential signing and attested result creation

Key files:

- `workers/nitro-worker/src/worker.js` — main entry for the Oracle CVM.
- `workers/nitro-worker/src/server.js` — local HTTP adapter around `worker.js`.
- `workers/nitro-worker/src/platform/core.js` — request handling, env, and JSON helpers.
- `workers/nitro-worker/src/platform/auth.js` — TEE-side auth.
- `workers/nitro-worker/src/platform/nitro-signer.js` — Nitro attestation and derived signing.
- `workers/nitro-worker/src/oracle/index.js` — oracle module lane.
- `workers/nitro-worker/src/oracle/feeds.js` — feed module lane.
- `workers/nitro-worker/src/oracle/feeds/` — feed state, sync policy, decimal handling, and Neo stack decoding.
- `workers/nitro-worker/src/compute/index.js` — compute module lane.
- `workers/nitro-worker/src/neodid/index.js` — NeoDID module lane.
- `workers/nitro-worker/src/platform/script-runner.js` — JS execution.
- `workers/nitro-worker/src/platform/wasm-runner.js` — WASM execution.
- `workers/nitro-worker/src/paymaster/index.js` — paymaster logic.
- `workers/nitro-worker/src/platform/policy-engine.js` — policy engine.
- `workers/nitro-worker/src/platform/allowlist.js` — platform allowlist.
- `workers/nitro-worker/src/platform/overload-guard.js` — overload protection.
- `workers/nitro-worker/src/platform/request-guards.js` — request guards.
- `workers/nitro-worker/src/platform/circuit-breaker.js` — circuit breaker.
- `workers/nitro-worker/src/platform/risk-observer.js` — risk observation.

## Runtime Roles

### Oracle CVM

- name: `oracle-morpheus-neo-r3e`
- app id: `ddff154546fe22d15b65667156dd4b7c611e6093`
- role: built-in confidential module lane for fetch/query, compute, NeoDID, and paymaster-related logic
- public paths: `https://oracle.meshmini.app/mainnet`, `https://oracle.meshmini.app/testnet`

### DataFeed CVM

- name: `datafeed-morpheus-neo-r3e`
- app id: `ac5b6886a2832df36e479294206611652400178f`
- role: isolated built-in shared resource publication lane
- priority: highest; feed publication must not be starved by interactive workloads

## Request/Response Flow

1. The client seals optional confidential fields with the runtime X25519 public key.
2. A registered or compatibility-mode Neo N3 contract submits an async kernel request.
3. The relayer persists the event before it advances checkpoints.
4. The appropriate built-in module lane executes the confidential job.
5. The runtime returns a signed result envelope and optional attestation metadata.
6. The relayer fulfills the request on-chain.
7. The kernel stores the canonical inbox item and optionally notifies an external adapter contract.

## DataFeed Flow

1. A control-plane or operator tick enters the `feed_tick` lane.
2. The DataFeed CVM fetches and normalizes source data.
3. Only materially changed quantized prices are prepared for publication.
4. The relayer publishes the update to `MorpheusDataFeed`, which acts as a shared numeric resource registry.
5. Feed snapshots and operational telemetry are recorded in Supabase.

## Network Model

- Mainnet and testnet share the same Oracle CVM.
- Mainnet and testnet share the same DataFeed CVM.
- Network selection is passed as runtime metadata and path prefix, not by provisioning separate CVMs per network.
- The Oracle execution plane is network-aware but topology-neutral.
- Built-in module lanes are reusable across many registered miniapps.

The canonical network registries are `config/networks/mainnet.json` and `config/networks/testnet.json`.

## On-Chain MiniApp OS

- `MorpheusOracle` is the shared MiniApp OS kernel. It owns miniapp registration, module registration, capability grants, request routing, inbox delivery, fee credits, and generic app state.
- `MorpheusDataFeed` is a built-in shared numeric resource module.
- `OracleCallbackConsumer` is an optional external adapter for advanced integrations.
- `NeoDIDRegistry` provides NeoDID registry support.

Key contract files:

- `contracts/MorpheusOracle/MorpheusOracle.cs` — kernel entry.
- `contracts/MorpheusOracle/MorpheusOracle.Requests.cs` — request handling.
- `contracts/MorpheusOracle/MorpheusOracle.Fulfillment.cs` — fulfillment logic.
- `contracts/MorpheusOracle/MorpheusOracle.Storage.cs` — storage layout.
- `contracts/MorpheusDataFeed/MorpheusDataFeed.cs` — data feed module.
- `contracts/NeoDIDRegistry/NeoDIDRegistry.cs` — NeoDID registry.
- `contracts/OracleCallbackConsumer/OracleCallbackConsumer.cs` — optional callback adapter.
- `contracts/__tests__/` — C# contract tests.
- `contracts/build/` — generated contract artifacts.

## EVM Contracts

The repository also contains EVM-compatible reference contracts and examples:

- `contracts-evm/MorpheusOracleEVM.sol` — EVM oracle implementation.
- `contracts-evm/IMorpheusOracleEVM.sol` — oracle interface.
- `contracts-evm/MorpheusPriceFeed.sol` — price feed example.
- `contracts-evm/MiniAppDiceGameEVM.sol` and `MiniAppMessageEVM.sol` — example miniapps.
- `contracts-evm/test/` — Solidity tests.

## Relayer

The relayer is the on-chain async bridge and callback relayer:

- `workers/morpheus-relayer/src/cli.js` — CLI entry with modes: `loop`, `once`, `metrics`, `metrics:prom`, `serve:metrics`, `config:validate`, `config:dump`.
- `workers/morpheus-relayer/src/relayer.js` — main relayer loop and run orchestration.
- `workers/morpheus-relayer/src/neo-n3.js` — Neo N3 chain scanning and fulfillment.
- `workers/morpheus-relayer/src/neox.js` — Neo X chain scanning.
- `workers/morpheus-relayer/src/feed-sync.js` — feed synchronization.
- `workers/morpheus-relayer/src/automation.js` — automation job processing.
- `workers/morpheus-relayer/src/automation-supervisor.js` — automation supervisor logic.
- `workers/morpheus-relayer/src/persistence.js` — Supabase persistence.
- `workers/morpheus-relayer/src/queue.js` — durable queue management.
- `workers/morpheus-relayer/src/state.js` — relayer state and metrics.
- `workers/morpheus-relayer/src/router.js` — request routing.
- `workers/morpheus-relayer/src/fulfillment.js` — on-chain fulfillment.
- `workers/morpheus-relayer/src/lib/neo-signers.js` — Neo signer helpers.
- `workers/morpheus-relayer/src/prometheus.js` — Prometheus metrics.
- `workers/morpheus-relayer/src/metrics-server.js` — metrics HTTP server.
- `workers/morpheus-relayer/src/heartbeat.js` — heartbeat sender.
- `workers/morpheus-relayer/src/attestation.js` — attestation handling.
- `workers/morpheus-relayer/src/config.js` — runtime configuration.
- `workers/morpheus-relayer/src/config-schema.js` — configuration schema.
- `workers/morpheus-relayer/src/config-introspect.js` — config introspection helpers.

## Web Application

The web application is a Next.js dashboard, docs, explorer, and backend routes used by the control plane:

- `apps/web/app/api/workflows/route.ts` — public workflow catalog.
- `apps/web/app/api/runtime/catalog/route.ts` — public runtime catalog.
- `apps/web/app/api/policies/route.ts` — public policy catalog.
- `apps/web/app/api/relayer/jobs/route.ts` — relayer job listing.
- `apps/web/app/api/relayer/jobs/retry/route.ts` — job retry endpoint.
- `apps/web/app/api/relayer/jobs/replay/route.ts` — job replay endpoint.
- `apps/web/app/api/relayer/dead-letters/route.ts` — dead-letter inspection.
- `apps/web/app/api/relayer/metrics/route.ts` — relayer metrics endpoint.
- `apps/web/app/api/cron/feed/run/route.ts` — feed cron trigger.
- `apps/web/app/api/cron/health/route.ts` — health cron trigger.
- `apps/web/app/api/feeds/status/route.ts` — feed status.
- `apps/web/app/api/onchain/state/route.ts` — on-chain state query.
- `apps/web/app/api/attestation/verify/route.ts` — attestation verification endpoint.
- `apps/web/lib/workflow-runtime.ts` — workflow catalog utilities.
- `apps/web/public/morpheus-runtime-catalog.json` — generated public runtime catalog artifact.
- `apps/web/public/morpheus-network-registry.json` — generated public network registry artifact.

## Shared Packages

`packages/shared` is the internal shared library used by workers and the control plane:

- `src/index.js` / `src/index.ts` — main exports.
- `src/utils.js` — utility functions (trim, timestamp parsing, JSON helpers).
- `src/cbor.js` — CBOR encoding/decoding.
- `src/cose-verify.js` — COSE verification.
- `src/confidential-envelope.js` — confidential envelope handling.
- `src/public-runtime.js` — public runtime types/helpers.
- `src/node-runtime.js` — Node runtime helpers.
- `src/automation-supervisor.js` — automation supervisor logic.
- `src/callback-methods.js` — callback method utilities.
- `src/neo-encoding.js` — Neo encoding.
- `src/neo-signers-core.js` — Neo signer core.
- `src/rate-limit.js` — rate limiting utilities.
- `src/workflow-catalog.js` — workflow catalog definitions.
- `src/stable-stringify-vectors.mjs` — stable vector stringification.

## Compute Catalog

The runtime exposes built-in compute capabilities for:

- hashes and signature verification
- modular arithmetic and matrix/vector math
- Merkle helpers
- ZKP planning and Groth16 verification helpers
- FHE planning helpers
- privacy masking and noise helpers

The catalog is designed so additional runtimes can be added later without changing the on-chain request model. The canonical public catalog is `apps/web/public/morpheus-runtime-catalog.json`, generated by `scripts/export-public-runtime-catalog.mjs`.

## Trust Boundaries

- Secrets are encrypted before leaving the client boundary.
- Control plane, edge gateway, and relayer never decrypt payloads.
- TEE outputs derived results only.
- Pricefeed publishing is isolated from request/response execution.
- Signer identities are pinned and checked before deployment.
- Public attestation anchors are verified in-app via the `/api/attestation/verify` endpoint (and the `/verifier` page), backed by AWS Nitro attestation for the Oracle and DataFeed CVMs.

## Key Architectural Patterns

- **Path-based network selection**: Use `/mainnet` or `/testnet` prefixes; runtime metadata carries the network, not the CVM.
- **Async callback model**: Oracle and compute requests are asynchronous and callback-based.
- **Operator-driven pricefeeds**: Pricefeeds are operator-driven and highest priority.
- **Narrow TEE boundary**: Keep ingress, orchestration, and durability outside the TEE; reserve CVMs for execution only.
- **Generated runtime catalog**: `apps/web/public/morpheus-runtime-catalog.json` is the canonical public export; consumer repos import it. CI must fail if the envelope version or workflow IDs drift.
- **Durable intake before execution**: The relayer persists on-chain events before advancing cursors, so crashes are recoverable without lost events.
- **Network-aware but topology-neutral execution**: The Oracle CVM handles both mainnet and testnet; selection is runtime metadata, not infrastructure.
